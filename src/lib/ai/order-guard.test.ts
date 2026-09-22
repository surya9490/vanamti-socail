import { describe, it, expect } from 'vitest'
import {
  ORDER_HOLDING_MESSAGE,
  claimsNoOrder,
  enforceOrderRules,
  hasOrderIntent,
  hasSalesIntent,
  isSupportSession,
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
  ])('%s', (text) => expect(hasSalesIntent(text)).toBe(true))

  it.each(['What happened to my order', 'I have just ordered half kg', 'how much time will delivery take for my order'])(
    'not: %s',
    (text) => expect(hasSalesIntent(text)).toBe(false),
  )
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
  it('no intent at all: recent customers are support, prospects are not', () => {
    expect(isSupportSession(['Hi'], { recentCustomer: true })).toBe(true)
    expect(isSupportSession(['Hi'])).toBe(false)
    expect(isSupportSession([])).toBe(false)
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
  it('delayed order keeps the apology but always hands off', () => {
    const r = enforceOrderRules({ ...ok, lookup: 'delayed', text: "I'm sorry it's taking longer — our team is checking now." })
    expect(r).toEqual({ text: "I'm sorry it's taking longer — our team is checking now.", handoff: true, reason: 'delayed_order' })
  })
})
