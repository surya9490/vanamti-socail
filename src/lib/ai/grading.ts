// ============================================================
// Lead-grade parsing for AI auto-replies.
//
// The auto-reply prompt asks the model to append `<GRADE>value</GRADE>`
// on a new line after its customer-facing reply, where value is one
// of hot / warm / cold. We extract the tag, strip it from the text
// that goes to the customer, and (in the caller) update the contact's
// lead_stage with a ratchet — never silently downgrade a hot lead.
//
// Everything here is pure — no I/O, easily testable.
// ============================================================

export type LeadStage = 'hot' | 'warm' | 'cold'

// Match <GRADE>value</GRADE> in the text, case-insensitive, tolerant
// of surrounding whitespace. Only the FIRST match wins; if the
// model produced multiple (buggy prompt behavior), later ones are
// treated as customer-visible text and stripped along with the
// first.
const GRADE_RE = /<GRADE>\s*(hot|warm|cold)\s*<\/GRADE>/gi

/**
 * Extract the grade emitted by the model and return the reply text
 * with all grade tags removed. If the model didn't include one,
 * grade is null and the text is returned unchanged (trimmed).
 */
export function extractGrade(raw: string): {
  grade: LeadStage | null
  text: string
} {
  if (!raw) return { grade: null, text: '' }

  const match = GRADE_RE.exec(raw)
  const grade = match ? (match[1].toLowerCase() as LeadStage) : null

  // Reset lastIndex so replaceAll below starts clean (RegExp state
  // is per-instance and the /g flag mutates it).
  GRADE_RE.lastIndex = 0
  const text = raw.replace(GRADE_RE, '').trim()

  return { grade, text }
}

// Ordering used for the ratchet: hot > warm > cold. A NEW grade
// only wins when it strictly outranks the CURRENT grade. Equal =
// keep the current (avoids a pointless UPDATE on every reply).
const RANK: Record<LeadStage, number> = { cold: 1, warm: 2, hot: 3 }

/**
 * Decide whether to update the stored grade. Returns the new grade
 * to write, or null to leave the stored value alone. Semantics:
 *
 *   * No stored grade + any new grade → write the new grade
 *   * Stored cold + warm/hot → upgrade
 *   * Stored warm + hot → upgrade
 *   * Stored X + same X → leave alone (no-op write)
 *   * Stored hot + anything lower → keep hot (no downgrade)
 *   * Stored anything + null new → keep current
 *
 * Human-driven changes (agents editing the contact directly)
 * bypass this — they set lead_stage arbitrarily, ratchet is only
 * for the AI's automated grading path.
 */
export function nextGrade(
  current: LeadStage | null,
  next: LeadStage | null,
): LeadStage | null {
  if (!next) return null
  if (!current) return next
  if (RANK[next] > RANK[current]) return next
  return null
}
