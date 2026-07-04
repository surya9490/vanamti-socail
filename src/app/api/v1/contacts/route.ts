// ============================================================
// POST /api/v1/contacts — public API contact upsert.
//
// The integration entry point for external systems (e.g. the
// Vanamati Shopify app pushing welcome-popup signups). Upserts by
// phone within the key's account: an existing contact (same
// normalized number) is updated in place, otherwise a new row is
// created. Optional tags are resolved find-or-create and attached —
// the same helpers the CSV importer uses, so all write paths agree.
//
// Scope: `contacts:write`.
//
// Request JSON:
//   {
//     "phone": "+919876543210",        // required
//     "name":  "Priya",                // optional
//     "email": "priya@example.com",    // optional
//     "tags":  ["welcome-popup"]       // optional
//   }
//
// Response: { data: { contact: {…}, created: boolean } }
// `contact.opted_out_at` is included so integrators can see who has
// replied STOP (they must not market to those numbers elsewhere).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, badRequest, toApiErrorResponse, ApiError } from '@/lib/api/v1/respond';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import {
  resolveImportTagIds,
  assignImportedContactTags,
} from '@/lib/contacts/resolve-import-tags';
import { normalizePhone, sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

interface ContactPayload {
  phone?: unknown;
  name?: unknown;
  email?: unknown;
  tags?: unknown;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');

    let body: ContactPayload;
    try {
      body = await request.json();
    } catch {
      throw badRequest('Request body must be JSON');
    }

    const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const sanitized = sanitizePhoneForMeta(rawPhone);
    if (!rawPhone || normalizePhone(rawPhone).length < 8 || !isValidE164(sanitized)) {
      throw badRequest('`phone` is required and must be a valid phone number with country code');
    }

    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
    const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : null;

    let tagNames: string[] = [];
    if (body.tags !== undefined) {
      if (
        !Array.isArray(body.tags) ||
        body.tags.some((t) => typeof t !== 'string')
      ) {
        throw badRequest('`tags` must be an array of strings');
      }
      tagNames = (body.tags as string[]).map((t) => t.trim()).filter(Boolean);
    }

    // Contacts carry a NOT NULL user_id audit FK. API callers have no
    // user session, so attribute writes to the account owner — the
    // same stable-default convention the webhook uses for inbound
    // messages (it attributes to the WhatsApp-config owner).
    const { data: account, error: accountErr } = await ctx.supabase
      .from('accounts')
      .select('owner_user_id')
      .eq('id', ctx.accountId)
      .single();
    if (accountErr || !account?.owner_user_id) {
      throw new ApiError('internal', 'Could not resolve account owner', 500);
    }
    const ownerUserId = account.owner_user_id as string;

    // Upsert by phone — same helper + race handling as the webhook.
    const existing = await findExistingContact(ctx.supabase, ctx.accountId, sanitized);

    let contact: Record<string, unknown>;
    let created = false;

    if (existing) {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (name) patch.name = name;
      if (email) patch.email = email;
      const { data: updated, error: updateErr } = await ctx.supabase
        .from('contacts')
        .update(patch)
        .eq('id', existing.id)
        .eq('account_id', ctx.accountId)
        .select()
        .single();
      if (updateErr) {
        throw new ApiError('internal', `Contact update failed: ${updateErr.message}`, 500);
      }
      contact = updated;
    } else {
      const { data: inserted, error: insertErr } = await ctx.supabase
        .from('contacts')
        .insert({
          account_id: ctx.accountId,
          user_id: ownerUserId,
          phone: sanitized,
          name: name || sanitized,
          email,
        })
        .select()
        .single();

      if (insertErr) {
        // Lost a race with another writer (unique index, migration 022):
        // re-resolve and treat as update.
        if (isUniqueViolation(insertErr)) {
          const raced = await findExistingContact(ctx.supabase, ctx.accountId, sanitized);
          if (raced) {
            contact = raced as Record<string, unknown>;
          } else {
            throw new ApiError('internal', 'Contact upsert race could not be resolved', 500);
          }
        } else {
          throw new ApiError('internal', `Contact create failed: ${insertErr.message}`, 500);
        }
      } else {
        contact = inserted;
        created = true;
      }
    }

    if (tagNames.length > 0) {
      const { tagIdByKey } = await resolveImportTagIds(ctx.supabase, {
        accountId: ctx.accountId,
        userId: ownerUserId,
        tagNames,
        canCreateTags: true,
      });
      await assignImportedContactTags(
        ctx.supabase,
        [{ contactId: contact.id as string, tagNames }],
        tagIdByKey,
      );
    }

    return ok(
      {
        contact: {
          id: contact.id,
          phone: contact.phone,
          name: contact.name ?? null,
          email: contact.email ?? null,
          opted_out_at: contact.opted_out_at ?? null,
          created_at: contact.created_at,
        },
        created,
      },
      created ? 201 : 200,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
