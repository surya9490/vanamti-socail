import type { SupabaseClient } from '@supabase/supabase-js'
import type { LeadStage } from '@/lib/ai/grading'

// ============================================================
// Lead-grade → tag mirror.
//
// contacts.lead_stage is the source of truth (typed, ratcheted).
// This helper mirrors it into the existing tag system so the inbox
// filter chips and contact list surface hot / warm / cold without
// any UI work — agents can already filter by tag today.
//
// Behavior:
//   * The three tags "hot", "warm", "cold" are ensured to exist for
//     the account on first use (idempotent — no error if already
//     there). Colors mirror the semantic: red / amber / grey.
//   * When we set lead_stage to X, we add tag X and remove the
//     other two so exactly one grade tag is on the contact at a
//     time.
//
// Called only from src/lib/ai/auto-reply.ts, immediately after the
// contacts.lead_stage update. Errors are logged and swallowed — a
// tag-mirror failure must never fail the auto-reply.
// ============================================================

const TAG_META: Record<LeadStage, { name: string; color: string }> = {
  hot: { name: 'hot', color: '#ef4444' }, // red-500
  warm: { name: 'warm', color: '#f59e0b' }, // amber-500
  cold: { name: 'cold', color: '#94a3b8' }, // slate-400
}

async function ensureTag(
  db: SupabaseClient,
  accountId: string,
  name: string,
  color: string,
): Promise<string | null> {
  const { data: existing } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', name)
    .maybeSingle()
  if (existing?.id) return existing.id as string

  // Ownership of the created tag: `user_id` is the legacy column
  // (pre-migration 017); leaving it NULL fails the NOT NULL
  // constraint (Postgres 23502). The account's owner_user_id
  // lives directly on the accounts row — that's the source of
  // truth. Prior version queried a non-existent account_members
  // table and silently fell through to null, breaking every
  // auto-reply that tried to grade a contact.
  const { data: acct } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle()
  const ownerUserId = (acct as { owner_user_id?: string } | null)
    ?.owner_user_id
  if (!ownerUserId) {
    console.warn(`[lead-tag] no owner_user_id for account ${accountId}`)
    return null
  }

  const { data: created, error } = await db
    .from('tags')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      name,
      color,
    })
    .select('id')
    .maybeSingle()

  if (error || !created?.id) {
    console.warn(`[lead-tag] ensure "${name}" failed:`, error)
    return null
  }
  return created.id as string
}

/**
 * Set the contact's lead-stage tag: attach the tag matching `stage`,
 * remove the other two. Idempotent. Swallows errors.
 */
export async function mirrorLeadStageToTag(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  stage: LeadStage,
): Promise<void> {
  try {
    // Resolve tag ids for all three stages up-front — one lookup batch.
    const stageEntries = (Object.entries(TAG_META) as [
      LeadStage,
      { name: string; color: string },
    ][])
    const ids: Partial<Record<LeadStage, string>> = {}
    for (const [k, meta] of stageEntries) {
      const id = await ensureTag(db, accountId, meta.name, meta.color)
      if (id) ids[k] = id
    }

    const targetId = ids[stage]
    if (!targetId) return // ensure failed for the target — nothing to do

    const others = (['hot', 'warm', 'cold'] as LeadStage[])
      .filter((s) => s !== stage)
      .map((s) => ids[s])
      .filter((id): id is string => Boolean(id))

    // Add the target tag (idempotent via the unique (contact_id, tag_id)).
    await db
      .from('contact_tags')
      .upsert(
        { contact_id: contactId, tag_id: targetId },
        { onConflict: 'contact_id,tag_id' },
      )

    // Remove the other two grade tags if present.
    if (others.length > 0) {
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', contactId)
        .in('tag_id', others)
    }
  } catch (err) {
    console.warn('[lead-tag] mirror failed:', err)
  }
}
