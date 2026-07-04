// ============================================================
// POST /api/v1/messages — public API message send.
//
// Machine-to-machine sends (e.g. the Vanamati Shopify app firing a
// welcome-code or back-in-stock template). Routes through this CRM —
// not straight to Meta — so every outbound lands in the shared inbox
// and the opt-out policy is enforced in exactly one place.
//
// Scope: `messages:send`.
//
// Request JSON (template — the normal case for business-initiated):
//   {
//     "to": "+919876543210",
//     "template": { "name": "welcome_code", "language": "en_US",
//                    "params": ["WELCOME10"] }
//   }
// Or free-form text (only lands inside an open 24h service window):
//   { "to": "+919876543210", "text": "Hi! …" }
//
// Opt-out policy (see lib/contacts/opt-out.ts):
//   - MARKETING templates to an opted-out contact → 400, refused.
//   - Templates whose category we can't determine → refused too
//     (fail closed); sync templates from Meta to classify them.
//   - UTILITY/AUTHENTICATION templates and free-form text replies
//     are allowed — transactional traffic the customer asked for.
//
// Response: { data: { message_id, to, status: "sent" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, badRequest, toApiErrorResponse, ApiError } from '@/lib/api/v1/respond';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendTemplateMessage, sendTextMessage } from '@/lib/whatsapp/meta-api';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';

interface MessagePayload {
  to?: unknown;
  text?: unknown;
  template?: {
    name?: unknown;
    language?: unknown;
    params?: unknown;
  };
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');

    let body: MessagePayload;
    try {
      body = await request.json();
    } catch {
      throw badRequest('Request body must be JSON');
    }

    const rawTo = typeof body.to === 'string' ? body.to.trim() : '';
    const to = sanitizePhoneForMeta(rawTo);
    if (!rawTo || !isValidE164(to)) {
      throw badRequest('`to` is required and must be a valid phone number with country code');
    }

    const hasTemplate = body.template && typeof body.template === 'object';
    const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : null;
    if (!hasTemplate && !text) {
      throw badRequest('Provide either `template` or `text`');
    }

    const templateName =
      hasTemplate && typeof body.template!.name === 'string' ? body.template!.name.trim() : '';
    if (hasTemplate && !templateName) {
      throw badRequest('`template.name` is required for template sends');
    }
    const templateLanguage =
      hasTemplate && typeof body.template!.language === 'string' && body.template!.language
        ? (body.template!.language as string)
        : 'en_US';
    let templateParams: string[] = [];
    if (hasTemplate && body.template!.params !== undefined) {
      if (
        !Array.isArray(body.template!.params) ||
        (body.template!.params as unknown[]).some((p) => typeof p !== 'string')
      ) {
        throw badRequest('`template.params` must be an array of strings');
      }
      templateParams = body.template!.params as string[];
    }

    // WhatsApp config for this account.
    const { data: config, error: configErr } = await ctx.supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .single();
    if (configErr || !config) {
      throw badRequest('WhatsApp is not configured for this account');
    }
    const accessToken = decrypt(config.access_token);

    // Existing contact (if any) — drives the opt-out check and inbox
    // mirroring. A brand-new recipient gets a contact row below.
    const existingContact = await findExistingContact(ctx.supabase, ctx.accountId, to);

    // Template row: needed to build header/button components AND to
    // classify marketing vs utility for the opt-out policy.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let templateRow: any = null;
    if (hasTemplate) {
      const { data: rawRow } = await ctx.supabase
        .from('message_templates')
        .select('*')
        .eq('account_id', ctx.accountId)
        .eq('name', templateName)
        .eq('language', templateLanguage)
        .maybeSingle();
      if (rawRow && !isMessageTemplate(rawRow)) {
        throw new ApiError(
          'internal',
          'Template row is malformed locally — run "Sync from Meta" in Settings to repair it',
          500,
        );
      }
      templateRow = rawRow ?? null;
    }

    // ── Opt-out enforcement ──────────────────────────────────────
    if (existingContact && (existingContact as { opted_out_at?: string | null }).opted_out_at) {
      if (hasTemplate) {
        const category = String(templateRow?.category ?? '').toLowerCase();
        const isTransactional = category === 'utility' || category === 'authentication';
        if (!isTransactional) {
          // Marketing — or unknown category (fail closed).
          throw badRequest(
            templateRow
              ? 'Recipient has opted out of marketing messages (STOP). Only utility/authentication templates may be sent.'
              : 'Recipient has opted out and this template is not synced locally, so its category is unknown. Sync templates from Meta, or use a utility template.',
          );
        }
      }
      // Free-form text falls through: it only ever lands inside an
      // open service window (Meta rejects it otherwise), which means
      // the customer messaged us in the last 24h.
    }

    // ── Send via Meta, retrying trunk-prefix variants ────────────
    const attempt = async (phone: string): Promise<string> => {
      if (hasTemplate) {
        const result = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          templateName,
          language: templateLanguage,
          template: templateRow ?? undefined,
          params: templateParams,
        });
        return result.messageId;
      }
      const result = await sendTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        text: text!,
      });
      return result.messageId;
    };

    let waMessageId = '';
    let workingPhone = to;
    let lastError: unknown = null;
    for (const variant of phoneVariants(to)) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          lastError = err;
          break;
        }
        lastError = err;
      }
    }
    if (!waMessageId) {
      const message = lastError instanceof Error ? lastError.message : 'Unknown Meta API error';
      throw new ApiError('internal', `Meta API error: ${message}`, 502);
    }

    // ── Mirror into the inbox (best-effort, never fails the send) ──
    try {
      const ownerUserId = await resolveOwnerUserId(ctx.supabase, ctx.accountId);
      const contactId = await ensureContact(ctx, existingContact, workingPhone, ownerUserId);
      const conversationId = await ensureConversation(ctx, contactId, ownerUserId);
      const contentText = hasTemplate ? `[template: ${templateName}]` : text!;

      await ctx.supabase.from('messages').insert({
        conversation_id: conversationId,
        sender_type: 'bot', // machine-sent via the public API
        content_type: hasTemplate ? 'template' : 'text',
        content_text: contentText,
        template_name: hasTemplate ? templateName : null,
        message_id: waMessageId,
        status: 'sent',
      });
      await ctx.supabase
        .from('conversations')
        .update({
          last_message_text: contentText,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId);
    } catch (mirrorErr) {
      console.error(
        '[api/v1/messages] inbox mirroring failed (message already sent):',
        mirrorErr instanceof Error ? mirrorErr.message : mirrorErr,
      );
    }

    return ok({ message_id: waMessageId, to: workingPhone, status: 'sent' });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

// ── Inbox-mirroring helpers ────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = { supabase: any; accountId: string };

async function resolveOwnerUserId(
  supabase: Ctx['supabase'],
  accountId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .single();
  if (error || !data?.owner_user_id) {
    throw new Error('Could not resolve account owner');
  }
  return data.owner_user_id as string;
}

async function ensureContact(
  ctx: Ctx,
  existing: { id: string } | null,
  phone: string,
  ownerUserId: string,
): Promise<string> {
  if (existing) return existing.id;
  const { data, error } = await ctx.supabase
    .from('contacts')
    .insert({
      account_id: ctx.accountId,
      user_id: ownerUserId,
      phone,
      name: phone,
    })
    .select('id')
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(ctx.supabase, ctx.accountId, phone);
      if (raced) return raced.id;
    }
    throw error;
  }
  return data.id as string;
}

async function ensureConversation(
  ctx: Ctx,
  contactId: string,
  ownerUserId: string,
): Promise<string> {
  const { data: existing } = await ctx.supabase
    .from('conversations')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data, error } = await ctx.supabase
    .from('conversations')
    .insert({
      account_id: ctx.accountId,
      user_id: ownerUserId,
      contact_id: contactId,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}
