// ============================================================
// The customer is closing the conversation. Two cases every
// follow-up path has to respect:
//
//   * a BARE ACKNOWLEDGMENT ("ok", "thanks", 👍) after we've already
//     said our piece. Answering each one is a ping-pong of sign-offs —
//     live 2026-10-13: #vana1153's buyer, writing from a second number,
//     sent a photo of the ghee and "Thanks 👍", then "Ok", "Thanks",
//     "Ok", and got a fresh "You're welcome / have a great day" for
//     every one of them (six bot messages in three minutes).
//   * a CLEAR NO ("not interested", "no thanks", "vendam"). One polite
//     reply is fine; a nudge or a check-in after it is spam.
//
// Both are deliberately strict. A wrong "ack" silences a real reply; a
// wrong "no" loses a nudge — so "yes", praise ("very good"), and a bare
// "no" (usually the answer to a question) are neither.
// ============================================================

import { detectCloseStage } from './close-nudge'

/** Words a pure acknowledgment is made of — and nothing else. */
const ACK_WORDS = new Set([
  'ok', 'okay', 'okey', 'oky', 'okie', 'k', 'kk', 'okk', 'okkk',
  'thanks', 'thank', 'thanku', 'thankyou', 'thnx', 'thx', 'tnx', 'tq', 'tqs', 'ty', 'tks',
  'you', 'u', 'so', 'much', 'very',
  'fine', 'sure', 'noted', 'done', 'alright', 'cool',
  'sir', 'madam', 'mam', 'maam', 'ji', 'bro',
])

/** Emoji that only ever mean "got it" / "thank you". */
const ACK_EMOJI_RE = /[👍👌🙏😊🙂☺✅❤♥🤝💐🌿]/gu
/** Skin-tone modifiers, variation selectors and joiners that ride along. */
const EMOJI_MODIFIER_RE = /[\u{1F3FB}-\u{1F3FF}️‍]/gu

/** "ok", "Thanks 👍", "ok thank you sir.", "👍🏻👍🏻", "🙏" — and nothing more. */
export function isBareAcknowledgment(text: string | null | undefined): boolean {
  const raw = String(text ?? '').trim()
  if (!raw) return false
  const hadAckEmoji = ACK_EMOJI_RE.test(raw)
  ACK_EMOJI_RE.lastIndex = 0
  const rest = raw
    .replace(ACK_EMOJI_RE, ' ')
    .replace(EMOJI_MODIFIER_RE, '')
    .toLowerCase()
    .replace(/[.,!~\-_*'"]+/g, ' ')
    .trim()
  if (!rest) return hadAckEmoji
  // Any other emoji or symbol (😡, ?) means it's saying something.
  if (/[^\p{L}\p{N}\s]/u.test(rest)) return false
  return rest.split(/\s+/).every((w) => ACK_WORDS.has(w))
}

export interface RecentMessage {
  senderType: string | null
  contentType: string | null
  contentText: string | null
}

/**
 * Should the AI stay quiet on this turn? Yes when everything the customer
 * sent since our last message is a bare acknowledgment AND that message of
 * ours left nothing open: no question, not a checkout step (address ask /
 * confirm / payment link — an "ok" there is the customer moving forward),
 * not a catalog or other interactive card. `recent` is newest first.
 *
 * With nothing of ours on the thread yet, the first "thanks" still gets its
 * one courtesy reply.
 */
export function isClosingAckTurn(recent: readonly RecentMessage[]): boolean {
  let sawAck = false
  for (const m of recent) {
    if (m.senderType === 'customer') {
      if (m.contentType !== 'text' || !isBareAcknowledgment(m.contentText)) return false
      sawAck = true
      continue
    }
    if (!sawAck) return false
    if (m.contentType === 'interactive') return false
    const ours = (m.contentText ?? '').trim()
    if (ours.includes('?')) return false
    return detectCloseStage(ours) === null
  }
  return false
}

/** A no anywhere in the message, at any length. */
const STRONG_DECLINE_PATTERNS: RegExp[] = [
  /\bnot\s+(?:at\s+all\s+)?(?:interested|intrested|intersted|interseted|interested\s+now)\b/i,
  /\bunsubscribe\b/i,
  /\b(?:stop|don'?t|dont|do\s+not|pls\s+don'?t|please\s+don'?t)\s+(?:send(?:ing)?\s+)?(?:me\s+)?(?:any\s+)?(?:more\s+)?(?:messages?|msgs?|texts?|spam)\b/i,
  /\b(?:stop|don'?t|dont|do\s+not)\s+(?:messag(?:e|ing)|texting|disturb(?:ing)?|spamming)\b/i,
  /\b(?:remove|delete)\s+my\s+(?:number|contact)\b/i,
]

/**
 * A no that only reads as one in a short message — in a longer one the
 * same words are usually about the order ("I don't want the 500ml, send
 * 1L", "no need for a bag", "1kg vendam, 500g podhum").
 */
const SHORT_DECLINE_PATTERNS: RegExp[] = [
  // The whole message — "No thank you for quick response" is a thank-you.
  /^(?:no|nope|nah|no\s+no)[\s,.!]*(?:thanks?|thank\s*(?:you|u)|thanku|tq|ty)(?:\s+(?:sir|madam|mam|ji|bro))?[\s.!🙏]*$/iu,
  /\b(?:don'?t|dont|do\s+not|doesn'?t)\s+(?:want|need|require)\b/i,
  /\b(?:no\s+need|not\s+(?:needed|required|necessary|now)|no\s+requirement)\b/i,
  /^\s*stop\s*$/i,
  /\b(?:vendam|vendaam|vendaa|venda|veanda)\b|வேண்டாம்|வேணாம்/i,
  /\b(?:nahi|nahin|nai)\s+(?:chahiye|chaiye|chahie)\b|नहीं\s*चाहिए/i,
  /\b(?:beda|bedaa|vaddu)\b|വേണ്ട|ಬೇಡ|వద్దు/i,
]

const SHORT_DECLINE_MAX_WORDS = 6

/** A quantity or a product named: the "no" is about the order, not to us. */
const ORDER_DETAIL_RE = /\d|\b(?:ghee|honey|oil|ml|kg|kgs|gm|gms|grams?|ltr|litre|liter|jar|bottle|pack)\b/i

/** "not interested", "no thanks", "don't want", "vendam" — a clear no. */
export function isDecline(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (STRONG_DECLINE_PATTERNS.some((re) => re.test(t))) return true
  if (t.split(/\s+/).length > SHORT_DECLINE_MAX_WORDS || ORDER_DETAIL_RE.test(t)) return false
  return SHORT_DECLINE_PATTERNS.some((re) => re.test(t))
}

/**
 * Did the customer's latest say turn the offer down? The newest message
 * that isn't a bare "ok" / "thanks" decides — "not interested" → "ok" is
 * still a no; "not interested" → "actually, show me the ghee" is not.
 * `customerTexts` newest first.
 */
export function customerDeclined(customerTexts: ReadonlyArray<string | null | undefined>): boolean {
  for (const text of customerTexts) {
    if (!String(text ?? '').trim() || isBareAcknowledgment(text)) continue
    return isDecline(text)
  }
  return false
}
