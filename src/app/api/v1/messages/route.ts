// ============================================================
// POST /api/v1/messages — send a WhatsApp message via the public API.
//
// The headline public endpoint (issue #245). Unlike the dashboard's
// `/api/whatsapp/send` (which takes an internal `conversation_id`),
// this takes a phone number — what an external automation actually
// has — resolves-or-creates the contact + conversation, then runs the
// same shared send core.
//
// Auth: API key with the `messages:send` scope. Account context (and
// the service-role client) come from `requireApiKey`.
//
// Body:
//   {
//     "to": "+14155550123",                 // required, E.164
//     "type": "text",                        // text|template|image|video|document|audio (default: text)
//     "text": "Hello!",                      // text body, or media caption
//     "media_url": "https://…/file.pdf",     // required for image/video/document/audio
//     "filename": "invoice.pdf",             // optional, document filename
//     "template": {                          // required when type=template
//       "name": "order_update",
//       "language": "en_US",
//       "params": ["A123"] | { "body": [...] }   // array = positional body; object = structured
//     },
//     "reply_to_message_id": "<uuid>",       // optional, must be in the same conversation
//     "name": "Jane Doe"                     // optional, names a newly-created contact
//   }
//
// Response (201):
//   { "data": { "message_id", "whatsapp_message_id", "conversation_id",
//               "contact_id", "contact_created" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!to) {
      return fail('bad_request', "'to' is required", 400);
    }

    const type = typeof body.type === 'string' ? body.type : 'text';

    // Unpack the optional `template` object into the flat params the
    // send core expects. `params` as an array → legacy positional body
    // params; as an object → structured header/body/button params.
    const template =
      body.template && typeof body.template === 'object'
        ? (body.template as Record<string, unknown>)
        : null;
    const templateParams = Array.isArray(template?.params)
      ? (template.params as unknown[]).filter(
          (p): p is string => typeof p === 'string'
        )
      : undefined;
    // Vanamati-compat: accept `template.headerMediaUrl` and
    // `template.buttonParams` as top-level template fields (what the
    // Vanamati Shopify app sends). Fold them into templateMessageParams
    // alongside main's `template.params: { ... }` structured form.
    const structuredParams =
      template?.params && !Array.isArray(template.params)
        ? (template.params as Record<string, unknown>)
        : null;
    const legacyMessageParams: Record<string, unknown> = {};
    if (typeof template?.headerMediaUrl === 'string') {
      legacyMessageParams.headerMediaUrl = template.headerMediaUrl;
    }
    if (template?.buttonParams && typeof template.buttonParams === 'object') {
      legacyMessageParams.buttonParams = template.buttonParams;
    }
    const templateMessageParams =
      structuredParams || Object.keys(legacyMessageParams).length > 0
        ? { ...(structuredParams ?? {}), ...legacyMessageParams }
        : undefined;

    // Validate the message shape BEFORE resolveConversationByPhone
    // finds-or-creates a contact + conversation, so a bad payload 400s
    // without leaving an orphan contact/conversation behind.
    // Validated by `validateSendMessageParams` below; the cast just bridges
    // the untyped JSON body to the send-core param type.
    const interactivePayload =
      body.interactive_payload && typeof body.interactive_payload === 'object'
        ? (body.interactive_payload as InteractiveMessagePayload)
        : null;

    validateSendMessageParams({
      messageType: type,
      contentText: typeof body.text === 'string' ? body.text : null,
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
      templateName: typeof template?.name === 'string' ? template.name : null,
      interactivePayload,
    });

    // Auto-resolve template language against the account's approved
    // templates. Meta rejects with 132001 ("Template name does not
    // exist in the translation") if the caller sends a language that
    // wasn't approved for that template name — e.g. sending `en_US`
    // when Meta only approved `en`. Callers routinely get this wrong
    // because language codes vary per template and Shopify apps /
    // integrations don't always know the exact approved variant.
    //
    // Resolution rules:
    //   1. Prefer the caller-provided language IF it matches an
    //      approved row for this template name. Preserves explicit
    //      choice when caller does know what they're doing.
    //   2. Otherwise pick any approved language for the template name
    //      (usually there's only one). Auto-corrects the common typo.
    //   3. If no approved row exists locally, pass through the
    //      caller's value unchanged and let Meta reject with the
    //      original 132001 — better than silently succeeding.
    const providedLanguage =
      typeof template?.language === 'string' ? template.language : null;
    let effectiveTemplateLanguage = providedLanguage;
    const templateName = typeof template?.name === 'string' ? template.name : null;
    if (templateName) {
      const { data: approvedRows } = await ctx.supabase
        .from('message_templates')
        .select('language')
        .eq('account_id', ctx.accountId)
        .eq('name', templateName)
        .eq('status', 'APPROVED');
      const approvedLangs = (approvedRows ?? [])
        .map((r) => (r as { language?: string }).language)
        .filter((l): l is string => typeof l === 'string' && l.length > 0);
      if (approvedLangs.length > 0) {
        effectiveTemplateLanguage =
          providedLanguage && approvedLangs.includes(providedLanguage)
            ? providedLanguage
            : approvedLangs[0];
      }
    }

    // Find-or-create the conversation for this phone, then send. Both
    // steps share `SendMessageError`, so one catch maps the whole
    // pipeline to the envelope.
    const resolved = await resolveConversationByPhone(
      ctx.supabase,
      ctx.accountId,
      to,
      typeof body.name === 'string' ? body.name : null
    );

    const result = await sendMessageToConversation(
      ctx.supabase,
      ctx.accountId,
      {
        conversationId: resolved.conversationId,
        messageType: type,
        contentText: typeof body.text === 'string' ? body.text : null,
        mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
        filename: typeof body.filename === 'string' ? body.filename : null,
        templateName,
        templateLanguage: effectiveTemplateLanguage,
        templateParams,
        templateMessageParams,
        interactivePayload,
        replyToMessageId:
          typeof body.reply_to_message_id === 'string'
            ? body.reply_to_message_id
            : null,
      }
    );

    return ok(
      {
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
        conversation_id: resolved.conversationId,
        contact_id: resolved.contactId,
        contact_created: resolved.contactCreated,
      },
      201
    );
  } catch (err) {
    if (err instanceof SendMessageError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
