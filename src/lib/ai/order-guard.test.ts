import { describe, it, expect } from 'vitest'
import {
  CLARIFY_MESSAGE,
  FUTURE_ORDER_MESSAGE,
  ORDER_HOLDING_MESSAGE,
  claimsNoOrder,
  classifyCustomerIntent,
  enforceOrderRules,
  hasOrderIntent,
  hasSalesIntent,
  isSupportSession,
  latestIntent,
  pushesNewPurchase,
} from './order-guard'

describe('hasOrderIntent — existing-order messages seen live', () => {
  it.each([
    'What happened to my order',
    'I have just ordered half kg',
    'May I know the status of this order',
    'Send courier tracking number',
    'vana1073',
    '#vana1061',
    'Is my order placed',
    'Almost 5 days',
    'When will my parcel come?',
    'I have not received my order',
    'The jar arrived damaged',
    'Amount debited but no confirmation',
    'Where is my order',
    'I already paid',
    // Indian languages, as customers actually type them
    'mera order kab aayega',
    'order nahi aaya abhi tak',
    'मेरा ऑर्डर कब आएगा',
    'en order enga irukku',
    'order varala innum',
    'என் ஆர்டர் எங்க',
    'naa order eppudu vastundi',
    'nanna order yavaga barutte',
    'ente order evide',
  ])('%s', (text) => expect(hasOrderIntent(text)).toBe(true))

  it.each([
    'Hi! I have a question about your products.',
    'i am in pune what about courier',
    'Do you deliver to Coimbatore?',
    'What is the price of forest honey?',
    'Yes',
    'Ghee',
    'I want to order half kg ghee',
  ])('not: %s', (text) => expect(hasOrderIntent(text)).toBe(false))
})

describe('hasSalesIntent', () => {
  it.each([
    'I want to order half kg ghee',
    'Order again please',
    'I want 2 more',
    'send me the catalog',
    'price of acacia honey?',
    'how much is the 1 litre ghee',
    'any discount?',
    'Do you have honey also?',
    'do you sell ghee?',
    'is 1 litre ghee available?',
  ])('%s', (text) => expect(hasSalesIntent(text)).toBe(true))

  it.each([
    'What happened to my order',
    'I have just ordered half kg',
    'how much time will delivery take for my order',
    'do you have my order details?',
    'do you have any tracking for my parcel',
  ])('not: %s', (text) => expect(hasSalesIntent(text)).toBe(false))
})

describe('isSupportSession (newest first)', () => {
  it('Zakir 17 Sep: "Yes" / "Ghee" are filler — "I have just ordered" decides → support', () => {
    expect(isSupportSession(['Yes', 'Ghee', 'I have just ordered half kg', 'Hi! I have a question about your products.'])).toBe(true)
  })
  it('Zakir 22 Sep: "Almost 5 days" / "What happened to my order" → support', () => {
    expect(isSupportSession(['Almost 5 days', 'What happened to my order'])).toBe(true)
  })
  it('a reorder the customer asked for is a sale, even after an order question', () => {
    expect(isSupportSession(['Yes', 'I want 2 more', 'my order arrived, loved it'])).toBe(false)
    expect(isSupportSession(['I ordered last week, now I want to order honey too'])).toBe(false)
  })
  it('"my order was delivered, do you have honey also?" → a product inquiry, sales tools allowed', () => {
    expect(isSupportSession(['My order was delivered yesterday, thanks! Do you have honey also?'])).toBe(false)
  })
  it('Hindi / Tamil order questions are support sessions', () => {
    expect(isSupportSession(['mera order kab aayega'])).toBe(true)
    expect(isSupportSession(['en order enga irukku'])).toBe(true)
  })

  it('no intent at all: recent customers are support, prospects are not', () => {
    expect(isSupportSession(['Hi'], { recentCustomer: true })).toBe(true)
    expect(isSupportSession(['Hi'])).toBe(false)
    expect(isSupportSession([])).toBe(false)
  })
})

describe('classifyCustomerIntent — ask, don\'t guess', () => {
  it.each([
    // Duraisamy, live 2026-09-22: a prospect saying he'll order next week
    'Best my order next week Ghee and Honey 1+1 kg send to phonepay my Addres.',
    'NEXT WEEK MY ORDER PL WAIT',
    'I will order after salary next month',
    'pl wait, will order later',
    'agle hafte order karunga',
    'adutha vaaram order pannuren',
    'not now, next week',
  ])('future: %s', (t) => expect(classifyCustomerIntent(t)).toBe('future_order'))

  it.each([
    'What happened to my order',
    'I have just ordered half kg',
    'I ordered last week, will it come next week?', // future words, but clearly an existing order
    'my order not received',
    'vana1073',
    'mera order kab aayega',
    'Almost 5 days',
  ])('existing: %s', (t) => expect(classifyCustomerIntent(t)).toBe('existing_order'))

  it.each([
    'my order 1 kg ghee',
    'my order ghee and honey 1+1 kg phonepe',
    'my order 2 jars honey 600001',
  ])('ambiguous: %s', (t) => expect(classifyCustomerIntent(t)).toBe('ambiguous'))

  it.each(['I want to order half kg ghee', 'send me the catalog', 'price of acacia honey?'])('sales: %s', (t) =>
    expect(classifyCustomerIntent(t)).toBe('sales'),
  )
  it.each(['Yes', 'ok', '👍', '', 'Hi'])('none: %s', (t) => expect(classifyCustomerIntent(t)).toBe('none'))

  it('latestIntent skips filler and takes the newest intent-bearing message', () => {
    expect(latestIntent(['Yes', 'NEXT WEEK MY ORDER PL WAIT', 'Best my order next week Ghee and Honey 1+1 kg'])).toBe('future_order')
    expect(latestIntent(['Yes', 'Ghee', 'I have just ordered half kg'])).toBe('existing_order')
    expect(latestIntent(['Hi'], { recentCustomer: true })).toBe('existing_order')
    expect(latestIntent(['Hi'])).toBe('none')
  })

  it('a future order is not a support session; an unclear one is', () => {
    expect(isSupportSession(['NEXT WEEK MY ORDER PL WAIT'])).toBe(false)
    expect(isSupportSession(['my order 1 kg ghee'])).toBe(true)
  })
})

describe('claimsNoOrder — the real bad replies', () => {
  it.each([
    "I checked but couldn't find an order under this number, Zakir.",
    "I'm so sorry for the confusion, Zakir — I've checked and I don't actually see an order placed under this number. It looks like it wasn't completed on our end.",
    "I'm not finding an order matching \"vana1073\" on this number, Karthik.",
    "Hi Iswarya! I couldn't find any recent orders linked to this number.",
    'No orders found for this number.',
    "It seems like your order wasn't placed.",
    "You haven't placed an order yet.",
    'That order does not exist.',
  ])('%s', (reply) => expect(claimsNoOrder(reply)).toBe(true))

  it.each([
    'Free shipping on every order, no minimum 🍯',
    'Order #vana1061 is confirmed and currently being packed 📦',
    "Your order hasn't shipped yet — it's being packed and ships within 2–3 business days.",
    'Great choice! Your order is placed 🌿',
    'No order is too small for free shipping!',
  ])('not: %s', (reply) => expect(claimsNoOrder(reply)).toBe(false))
})

describe('pushesNewPurchase', () => {
  it.each([
    'Perfect! So 500ml A2 Cow Ghee it is. Let me get that set up for you. Please share your full details so I can create your order: full name, address (line 1 + area), city, state, and 6-digit pincode.',
    "Let's fix this right away — I'll set up your 500ml A2 Cow Ghee (₹1099) order now. Shall I send you the payment link?",
    'Here is your link: https://vanamati.com/74506633351/invoices/abc123',
    'Want me to place a new order for you?',
  ])('%s', (reply) => expect(pushesNewPurchase(reply)).toBe(true))

  it.each(['Order #vana1061 is confirmed and being packed 📦', "You're welcome! 🌿"])('not: %s', (reply) =>
    expect(pushesNewPurchase(reply)).toBe(false),
  )
})

describe('enforceOrderRules', () => {
  const ok = { text: 'Order #vana1061 is confirmed and being packed 📦', handoff: false, lookup: 'found' as const, supportSession: true }

  it('a normal status reply goes out as written', () => {
    expect(enforceOrderRules(ok)).toEqual({ text: ok.text, handoff: false, reason: null })
  })
  it('lookup missed → holding line + handoff, whatever the model wrote', () => {
    expect(enforceOrderRules({ ...ok, lookup: 'missed', text: 'Could you share your order number?' })).toEqual({
      text: ORDER_HOLDING_MESSAGE, handoff: true, reason: 'lookup_missed',
    })
  })
  it('lookup down → holding line + handoff', () => {
    expect(enforceOrderRules({ ...ok, lookup: 'down' }).reason).toBe('lookup_down')
  })
  it('"no order" claim → blocked even with no lookup and outside support', () => {
    const r = enforceOrderRules({ text: "I don't see an order placed under this number.", handoff: false, lookup: null, supportSession: false })
    expect(r).toEqual({ text: ORDER_HOLDING_MESSAGE, handoff: true, reason: 'claimed_no_order' })
  })
  it('new-purchase push in a support session → blocked', () => {
    const r = enforceOrderRules({ text: "Let me get that set up for you. Please share your full name, address (line 1 + area)…", handoff: false, lookup: null, supportSession: true })
    expect(r.reason).toBe('sold_in_support')
  })
  it('the same push in a SALES conversation is allowed', () => {
    const text = 'Please share your full name, address (line 1 + area), city, state, and 6-digit pincode.'
    expect(enforceOrderRules({ text, handoff: false, lookup: null, supportSession: false })).toEqual({ text, handoff: false, reason: null })
  })
  it('lookup missed on an UNCLEAR message → clarifying question, no handoff', () => {
    expect(enforceOrderRules({ ...ok, lookup: 'missed', intent: 'ambiguous', text: 'Could you share your order number?' })).toEqual({
      text: CLARIFY_MESSAGE, handoff: false, reason: 'lookup_missed_unclear',
    })
  })
  it('future order: a holding line or a handoff is replaced by a friendly wait line (Duraisamy)', () => {
    expect(enforceOrderRules({ text: ORDER_HOLDING_MESSAGE, handoff: true, lookup: 'missed', supportSession: false, intent: 'future_order' })).toEqual({
      text: FUTURE_ORDER_MESSAGE, handoff: false, reason: 'future_order_fallback',
    })
  })
  it('future order: a sensible model reply goes out unchanged, never hands off', () => {
    const text = "Sure, Duraisamy — 1 kg ghee + 1 kg honey next week sounds great 🌿 Just message me when you're ready and I'll set it up."
    expect(enforceOrderRules({ text, handoff: false, lookup: null, supportSession: false, intent: 'future_order' })).toEqual({ text, handoff: false, reason: null })
  })
  it('future order: "you haven\'t placed an order yet" is not a false claim', () => {
    const text = "No problem — you haven't placed an order yet, so just message me next week and I'll set it up 🌿"
    expect(enforceOrderRules({ text, handoff: false, lookup: null, supportSession: false, intent: 'future_order' }).text).toBe(text)
  })
  it('unclear message + purchase push → clarifying question, no handoff', () => {
    const r = enforceOrderRules({ text: 'Please share your full name, address (line 1 + area)…', handoff: false, lookup: null, supportSession: true, intent: 'ambiguous' })
    expect(r).toEqual({ text: CLARIFY_MESSAGE, handoff: false, reason: 'sold_in_unclear' })
  })

  it('delayed order keeps the apology but always hands off', () => {
    const r = enforceOrderRules({ ...ok, lookup: 'delayed', text: "I'm sorry it's taking longer — our team is checking now." })
    expect(r).toEqual({ text: "I'm sorry it's taking longer — our team is checking now.", handoff: true, reason: 'delayed_order' })
  })
})
