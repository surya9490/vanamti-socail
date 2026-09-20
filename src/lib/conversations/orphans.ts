// ============================================================
// Orphan ("No messages yet") conversation shells.
//
// Every outbound send path resolves-or-creates the contact and
// conversation BEFORE calling Meta. When the send then fails — Meta
// rejects it, or the process dies mid-request (a 502 during a
// container cut-over) — the empty shell survives: a conversation with
// no messages and, often, a contact whose name is just the phone
// number the API defaulted to.
//
// Two cleanups share the rules here:
//   * rollbackEmptyShell — inline, right after a failed send, for the
//     rows THAT request created (resolve-conversation.ts).
//   * /api/cron/cleanup-empty-conversations — hourly sweep for what
//     the inline path can't catch (process died before the catch).
// ============================================================

export interface OrphanContactFacts {
  name: string | null
  phone: string
  /** Conversations still attached to this contact (after the empty
   *  one is removed). */
  remainingConversations: number
  tags: number
  broadcastRecipients: number
}

/**
 * A contact is safe to delete alongside its orphan conversation only
 * when NOTHING human or campaign-shaped is attached to it: no other
 * conversations, no tags, no broadcast history, and no real name —
 * `name` equal to the phone (the API default when a caller sends no
 * name) or empty. A contact an agent named, tagged, or broadcast to
 * stays, empty conversation or not.
 */
export function isOrphanContact(f: OrphanContactFacts): boolean {
  if (f.remainingConversations > 0) return false
  if (f.tags > 0) return false
  if (f.broadcastRecipients > 0) return false
  const name = (f.name ?? '').trim()
  const phoneDigits = f.phone.replace(/\D/g, '')
  const nameDigits = name.replace(/\D/g, '')
  return name === '' || (nameDigits.length > 0 && nameDigits === phoneDigits)
}

/** Grace period before the sweeper touches an empty conversation — an
 *  in-flight send that's slow but alive must not be swept. */
export const ORPHAN_MIN_AGE_MS = 2 * 60 * 60 * 1000
