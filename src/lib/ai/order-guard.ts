// ============================================================
// Order guard — hard rules for conversations about an order the
// customer ALREADY placed. Enforced in code, after the model has
// written its reply, because prompt rules alone failed live:
//
//   2026-09-17  "I have just ordered half kg" → the bot started a NEW
//               order and asked for the address.
//   2026-09-22  "What happened to my order" (a paid order, 5 days old)
//               → "I don't see an order placed… it wasn't completed…
//               shall I send you the payment link?" The customer read
//               it as us trying to collect money twice and threatened a
//               complaint.
//
// Rules:
//   1. Never tell a customer they have no order / it wasn't placed /
//      wasn't completed / can't be found.
//   2. In a SUPPORT session (their latest intent is about an existing
//      order), never push a new purchase: no catalog, no draft order,
//      no payment link, no address collection.
//   3. When the bot can't find or confirm their order, it says ONE
//      fixed holding line and a person takes over.
//
// Pure: no database, no network.
// ============================================================

/** The only thing the bot says when it can't find / confirm an order. */
export const ORDER_HOLDING_MESSAGE =
  "Please give me some time to check your order status — I'll update you here shortly 🙏"

// ── Customer side: what is this conversation about? ─────────────────

/** Signals that the customer is talking about an order they already placed. */
const ORDER_INTENT_PATTERNS: RegExp[] = [
  /\b(i|we)('ve|\s+have|\s+had)?\s+(just\s+|already\s+|recently\s+)*(ordered|bought|purchased|paid|placed\s+(an?\s+|my\s+|the\s+)?order|made\s+(the\s+|a\s+)?payment)\b/i,
  /\b(my|our)\s+(order|parcel|package|delivery|shipment|payment|money)\b/i,
  /\border\s+(status|no\.?|number|id|details)\b/i,
  /\bstatus\s+of\s+(my|the|this|our|that)\b/i,
  /\bwhere\s+is\s+(my|the|our)\b/i,
  /\bwhat\s+happened\s+to\b/i,
  /\btracking\b|\btrack\s+(my|the|this|our|order|parcel|package)\b/i,
  /\bcourier\s+(tracking|number|no|status|details|id)\b|\bawb\b|\bconsignment\b/i,
  /\b(not|n't|never)\s+(yet\s+)?(been\s+)?(received|delivered|arrived|reached|come|came)\b/i,
  /\b(is|has|was)\s+(it|my\s+order|the\s+order|order)\s+(been\s+)?(shipped|dispatched|delivered|sent)\b/i,
  /\b(damaged|leaking|leaked|broken|spoiled|refund|replacement)\b|\bwrong\s+(item|product|order)\b|\bmissing\s+item/i,
  /\bcancel(led|lation)?\b/i,
  /\bvana\s*-?\s*\d{3,}\b|#\s*\d{3,}\b/i,
  /\b(amount|money|payment)\s+(was\s+)?(debited|deducted|done|made|completed|paid)\b/i,
  /\b(order|parcel)\s+(is\s+)?(not|n't|still|yet)\b/i,
  /\b(it'?s\s+been|almost|already|past)\s+\d+\s+days?\b/i,
  // Hinglish / Hindi — "mera order kab aayega", "order nahi aaya", "मेरा ऑर्डर"
  /\b(mera|mere|meri|hamara|hamare|apna|humara)\s+(order|parcel|package|delivery|payment)\b/i,
  /\border\s+(kab|kaha+n?|kidhar|kyu+n?|abhi\s+tak|nahi+|nhi|kahan|aayega|aaya|milega|mila|pahuncha|pohcha|hua)\b/i,
  /(मेरा|मेरे|मेरी|हमारा)\s*(ऑर्डर|आर्डर|ओर्डर|पार्सल|डिलीवरी)|(ऑर्डर|आर्डर|ओर्डर)\s*(कब|कहाँ|कहां|नहीं|आया|आएगा|मिला|मिलेगा|पहुंचा)/,
  // Tamil (Tanglish + script) — "en order enga irukku", "order varala"
  /\b(en|enga|enakku|namma)\s+(order|parcel)\b/i,
  /\border\s+(enga|eppo|eppadi|varum|varala|vanthuduchu|vandhucha|kedaikala|status\s+enna)\b/i,
  /(என்|எங்க)\s*(ஆர்டர்|ஆர்டரை|பார்சல்)|ஆர்டர்\s*(எங்க|எப்போ|வரல|வந்துருச்சா|வந்தது)/,
  // Telugu — "naa order eppudu vastundi", Kannada — "nanna order yavaga", Malayalam — "ente order evide"
  /\b(naa|na|maa)\s+order\b|\border\s+(eppudu|ekkada|ravaledu|vachinda|vastundi)\b/i,
  /\b(nanna|namma)\s+order\b|\border\s+(yavaga|elli|barlilla|bantha)\b/i,
  /\b(ente|njangalude)\s+order\b|\border\s+(eppol|evide|vannilla|vanno)\b/i,
  /(నా|మా)\s*ఆర్డర్|(ನನ್ನ|ನಮ್ಮ)\s*ಆರ್ಡರ್|(എന്റെ|ഞങ്ങളുടെ)\s*ഓർഡർ/,
]

/** Signals that the customer wants to BUY something (new or repeat). */
const SALES_INTENT_PATTERNS: RegExp[] = [
  /\b(want|would\s+like|wanna|like|wish)\s+to\s+(order|buy|purchase|try|get)\b/i,
  /\b(order|buy)\s+(again|more|another|one\s+more|some\s+more)\b/i,
  /\bre-?order\b|\bnew\s+order\b|\banother\s+order\b|\bone\s+more\b/i,
  /\b(i|we)\s+(want|need|'?ll\s+take|will\s+take)\s+(\d|one|two|three|four|five|a|an|another|some|more|half|1)\b/i,
  /\b(send|share|show)\s+(me\s+)?(the\s+|your\s+)?(catalog|catalogue|products?|price\s*list|menu|range)\b/i,
  /\bcatalog(ue)?\b/i,
  /\b(price|cost|rate)\s+(of|for)\b|\bhow\s+much\s+(is|for|does|are|do)\b/i,
  /\b(discount|coupon|offer)s?\b/i,
  // "do you have honey also?", "do you sell ghee?", "is 1 litre available?" —
  // a product inquiry, unless the same sentence is about an order/parcel.
  /\b(do|did)\s+you\s+(also\s+|guys\s+)?(have|sell|stock|make|keep)\b(?![^.?!\n]*\b(order|parcel|package|tracking|delivery|record)\b)/i,
  /\b(is|are)\s+[^.?!\n]{0,40}\b(available|in\s+stock)\b(?![^.?!\n]*\b(order|parcel)\b)/i,
]

export function hasOrderIntent(text: string | null | undefined): boolean {
  const t = String(text ?? '')
  return ORDER_INTENT_PATTERNS.some((re) => re.test(t))
}

export function hasSalesIntent(text: string | null | undefined): boolean {
  const t = String(text ?? '')
  return SALES_INTENT_PATTERNS.some((re) => re.test(t))
}

/**
 * Is this a SUPPORT session? The customer's most recent message that shows
 * any intent decides: about an existing order → support; wanting to buy →
 * sales. Filler ("yes", "ok", "Ghee", 👍) is skipped. With no intent at all,
 * a customer who ordered recently (order / delivery / review template on the
 * thread) is treated as support — they didn't come to be sold to.
 *
 * `customerTexts` newest first.
 */
export function isSupportSession(
  customerTexts: ReadonlyArray<string | null | undefined>,
  opts: { recentCustomer?: boolean } = {},
): boolean {
  for (const text of customerTexts) {
    // Buying intent in the same message wins ("I ordered last week — now I
    // want 2 more"): that is a sale the customer asked for.
    if (hasSalesIntent(text)) return false
    if (hasOrderIntent(text)) return true
  }
  return Boolean(opts.recentCustomer)
}

// ── Bot side: does the reply break a rule? ──────────────────────────

const NO_ORDER_PATTERNS: RegExp[] = [
  /\b(could\s*n'?t|could\s+not|can'?t|cannot|unable\s+to|not\s+able\s+to|do\s*n'?t|did\s*n'?t|am\s+not|i'?m\s+not|not)\s+(actually\s+|seem\s+to\s+|currently\s+)?(find|see|finding|seeing|locate|trace)\b[^.?!\n]{0,50}\border/i,
  /\bno\s+(recent\s+|such\s+|active\s+|matching\s+)?orders?\s+(found|placed|linked|matching|under|on|with|exists?|for|in)\b/i,
  /\border\b[^.?!\n]{0,40}\b(was\s*n'?t|was\s+not|is\s*n'?t|is\s+not|has\s*n'?t|has\s+not|had\s+not|never|not)\s+(been\s+|yet\s+|actually\s+)?(placed|completed|confirmed|created|received|processed|successful|found|recorded|registered)\b/i,
  /\b(have|has|did)\s*n'?t\s+(yet\s+)?(place|placed|make|made|complete|completed)\b[^.?!\n]{0,30}\border/i,
  /\b(looks|seems)\s+like\s+(it|the\s+order|your\s+order|the\s+payment)\s+(was\s*n'?t|was\s+not|did\s*n'?t|did\s+not|never)\b/i,
  /\border\b[^.?!\n]{0,40}\b(does\s*n'?t|does\s+not)\s+exist\b/i,
]

const NEW_PURCHASE_PATTERNS: RegExp[] = [
  /https?:\/\/\S*\/(invoices|checkouts|carts)\//i,
  /\bpayment\s+link\b/i,
  /\bset\s+(it|that|this|them)\s+up\b/i,
  /\bset\s+up\s+(your|the|a|an|this|that)\b[^.?!\n]{0,40}\border\b/i,
  /\b(place|create|book|start)\s+(your|the|a|an|this|that)\s+(new\s+)?order\b/i,
  /\bfull\s+name\b|\baddress\s*\(line|\b6-digit\s+pincode\b|\bshare\s+your\s+(full\s+)?(details|address|delivery\s+address)\b/i,
  /\bshall\s+i\s+send\b/i,
  /\bcomplete\s+(your|the)\s+(payment|order|checkout|purchase)\b/i,
]

/** "I couldn't find an order", "it wasn't completed", "no order found"… */
export function claimsNoOrder(reply: string | null | undefined): boolean {
  const t = String(reply ?? '')
  return NO_ORDER_PATTERNS.some((re) => re.test(t))
}

/** Address ask, "set up your order", payment link, "shall I send…". */
export function pushesNewPurchase(reply: string | null | undefined): boolean {
  const t = String(reply ?? '')
  return NEW_PURCHASE_PATTERNS.some((re) => re.test(t))
}

/** Outcome of the LAST order lookup the model made this turn, if any. */
export type OrderLookupOutcome = 'found' | 'missed' | 'down' | 'delayed'

export type GuardReason =
  | 'lookup_missed'
  | 'lookup_down'
  | 'claimed_no_order'
  | 'sold_in_support'
  | 'delayed_order'

/**
 * Final say on what goes out. The model's reply stands unless it breaks a
 * rule; then the customer gets the holding line and a person takes over.
 * A delayed order keeps the model's apology but always hands off.
 */
export function enforceOrderRules(input: {
  text: string
  handoff: boolean
  lookup: OrderLookupOutcome | null
  supportSession: boolean
}): { text: string; handoff: boolean; reason: GuardReason | null } {
  const hold = (reason: GuardReason) => ({ text: ORDER_HOLDING_MESSAGE, handoff: true, reason })
  if (input.lookup === 'missed') return hold('lookup_missed')
  if (input.lookup === 'down') return hold('lookup_down')
  if (input.text && claimsNoOrder(input.text)) return hold('claimed_no_order')
  if (input.supportSession && input.text && pushesNewPurchase(input.text)) return hold('sold_in_support')
  if (input.lookup === 'delayed') {
    return {
      text: input.text || ORDER_HOLDING_MESSAGE,
      handoff: true,
      reason: 'delayed_order',
    }
  }
  return { text: input.text, handoff: input.handoff, reason: null }
}

/** Tools that sell or take money — never offered in a support session. */
export const SALES_TOOL_NAMES: ReadonlySet<string> = new Set([
  'send_product_catalog',
  'send_product_carousel',
  'create_draft_order',
  'get_active_offers',
])
