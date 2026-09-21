import { describe, it, expect } from 'vitest'
import { evaluateThread, findSalesStage, isQuietHour, localHour, type SessionMessage } from './re-engagement'

const NOW = Date.parse('2026-09-20T14:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
const opts = { now: NOW, maxAgeHours: 168, stageTemplateNames: new Set(['reengage_day2']) }

const quietWarmLead = {
  conversationStatus: 'open',
  aiAutoreplyDisabled: false,
  lastMessage: { senderType: 'bot', contentType: 'text', templateName: null },
  lastCustomerMessageAt: hoursAgo(3.7),
  salesStage: 'catalog_sent' as const,
  recentCustomer: false,
}

describe('evaluateThread', () => {
  it('is eligible for a warm lead who went quiet after our text reply — grade is not a filter', () => {
    const v = evaluateThread(quietWarmLead, opts)
    expect(v.eligible).toBe(true)
    if (v.eligible) expect(v.hoursSince).toBeCloseTo(3.7, 2)
  })

  it('treats a human agent reply as "ours" too', () => {
    const v = evaluateThread(
      { ...quietWarmLead, lastMessage: { senderType: 'agent', contentType: 'text', templateName: null } },
      opts,
    )
    expect(v.eligible).toBe(true)
  })

  it('skips closed and pending conversations', () => {
    expect(evaluateThread({ ...quietWarmLead, conversationStatus: 'closed' }, opts)).toEqual({ eligible: false, reason: 'not_open' })
    expect(evaluateThread({ ...quietWarmLead, conversationStatus: 'pending' }, opts)).toEqual({ eligible: false, reason: 'not_open' })
    expect(evaluateThread({ ...quietWarmLead, conversationStatus: null }, opts)).toEqual({ eligible: false, reason: 'not_open' })
  })

  it('skips a thread handed off to a human (AI paused)', () => {
    expect(evaluateThread({ ...quietWarmLead, aiAutoreplyDisabled: true }, opts)).toEqual({ eligible: false, reason: 'ai_paused' })
  })

  it('skips a contact who never wrote (broadcast-only)', () => {
    expect(evaluateThread({ ...quietWarmLead, lastCustomerMessageAt: null }, opts)).toEqual({ eligible: false, reason: 'no_customer_message' })
  })

  it('skips when the customer is the one waiting on us', () => {
    expect(
      evaluateThread(
        { ...quietWarmLead, lastMessage: { senderType: 'customer', contentType: 'text', templateName: null } },
        opts,
      ),
    ).toEqual({ eligible: false, reason: 'awaiting_our_reply' })
    expect(evaluateThread({ ...quietWarmLead, lastMessage: null }, opts)).toEqual({ eligible: false, reason: 'awaiting_our_reply' })
  })

  it('skips post-purchase / app-driven flows (transactional template was our last message)', () => {
    for (const name of ['order_confirmation_v1', 'review_request_v2', 'cart_recovery_v3', 'welcome_code']) {
      expect(
        evaluateThread(
          { ...quietWarmLead, lastMessage: { senderType: 'bot', contentType: 'template', templateName: name } },
          opts,
        ),
      ).toEqual({ eligible: false, reason: 'transactional_flow' })
    }
  })

  it('does NOT skip when our last message was one of our own re-engagement templates (stage 2 can follow stage 1)', () => {
    const v = evaluateThread(
      { ...quietWarmLead, lastMessage: { senderType: 'bot', contentType: 'template', templateName: 'reengage_day2' } },
      opts,
    )
    expect(v.eligible).toBe(true)
  })

  it('skips silence at or beyond the max age', () => {
    expect(evaluateThread({ ...quietWarmLead, lastCustomerMessageAt: hoursAgo(168) }, opts)).toEqual({ eligible: false, reason: 'too_old' })
    expect(evaluateThread({ ...quietWarmLead, lastCustomerMessageAt: 'not a date' }, opts)).toEqual({ eligible: false, reason: 'too_old' })
  })
})

describe('evaluateThread — sales stage and recent customer rails', () => {
  it('skips a support-only thread (no products shown, no checkout)', () => {
    expect(evaluateThread({ ...quietWarmLead, salesStage: null }, opts)).toEqual({ eligible: false, reason: 'no_sales_stage' })
  })

  it('skips a recent customer who was merely shown the catalog (the Iswarya case)', () => {
    expect(evaluateThread({ ...quietWarmLead, salesStage: 'catalog', recentCustomer: true }, opts)).toEqual({ eligible: false, reason: 'recent_customer' })
    expect(evaluateThread({ ...quietWarmLead, salesStage: 'catalog_sent', recentCustomer: true }, opts)).toEqual({ eligible: false, reason: 'recent_customer' })
  })

  it('still re-engages a recent customer who was explicitly mid-checkout', () => {
    for (const stage of ['address_ask', 'address_confirm', 'payment_link_sent'] as const) {
      expect(evaluateThread({ ...quietWarmLead, salesStage: stage, recentCustomer: true }, opts).eligible).toBe(true)
    }
  })
})

describe('findSalesStage', () => {
  const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
  const msg = (p: Partial<SessionMessage> & { id: string }): SessionMessage => ({
    senderType: 'bot', contentType: 'text', contentText: null, templateName: null, createdAt: at(1), ...p,
  })
  const base = { lastCustomerAt: at(3.7), ignoreMessageIds: new Set<string>(), ignoreTexts: new Set<string>(), stageTemplateNames: new Set<string>() }

  it('returns null for a support-only session ("where is my order" → "you are welcome")', () => {
    const session = [
      msg({ id: 'a', contentText: "You're welcome, Iswarya! 🌿 If you need anything else, just message us.", createdAt: at(3.6) }),
      msg({ id: 'b', contentText: 'Got it! Order #vana1061 is confirmed and currently being packed 📦', createdAt: at(3.65) }),
      msg({ id: 'c', senderType: 'customer', contentText: '#vana1061', createdAt: at(3.7) }),
    ]
    expect(findSalesStage(session, base)).toBeNull()
  })

  it('finds the catalog when one was sent in the session, even if later replies are plain', () => {
    const session = [
      msg({ id: 'a', contentText: "You're welcome!", createdAt: at(3.6) }),
      msg({ id: 'b', contentType: 'interactive', contentText: "Here's what we have at Vanamati — tap any product 🌿", createdAt: at(3.8) }),
    ]
    expect(findSalesStage(session, base)).toBe('catalog')
  })

  it('reports the strongest stage (checkout beats catalog) and ignores nudges + our check-ins', () => {
    const checkin = "Hi! Just checking in 🌿 Still thinking it over?"
    const session = [
      msg({ id: 'chk', senderType: 'agent', contentText: checkin, createdAt: at(0.5) }),
      msg({ id: 'n1', contentText: 'Still there? Ready when you are — just share your name, address, city, state, and pincode', createdAt: at(3.5) }),
      msg({ id: 'a', contentText: 'Sure, no rush 🌿 Whenever you are ready, just message me.', createdAt: at(3.6) }),
      msg({ id: 'b', contentText: "Let's get this shipped — please share your full name, address (line 1 + area), city, state, and 6-digit pincode.", createdAt: at(4) }),
      msg({ id: 'c', contentType: 'interactive', contentText: 'Here you go — tap any product', createdAt: at(5) }),
    ]
    expect(findSalesStage(session, { ...base, ignoreMessageIds: new Set(['n1']), ignoreTexts: new Set([checkin]) })).toBe('address_ask')
  })

  it('does not look past the session window into an old sales episode', () => {
    const session = [
      msg({ id: 'a', contentText: "You're welcome!", createdAt: at(3.6) }),
      msg({ id: 'old', contentType: 'interactive', contentText: 'catalog from last week', createdAt: at(3.7 + 30) }),
    ]
    expect(findSalesStage(session, base)).toBeNull()
  })

  it('never treats templates as a sales stage', () => {
    const session = [msg({ id: 't', contentType: 'template', templateName: 'reengage_day2', createdAt: at(1) })]
    expect(findSalesStage(session, base)).toBeNull()
  })
})

describe('quiet hours', () => {
  const IST = 'Asia/Kolkata'
  // 2026-09-20T19:30Z = 01:00 IST next day; 03:30Z = 09:00 IST; 16:30Z = 22:00 IST
  it('reads the local hour in the given zone', () => {
    expect(localHour(new Date('2026-09-20T19:30:00Z'), IST)).toBe(1)
    expect(localHour(new Date('2026-09-20T03:30:00Z'), IST)).toBe(9)
    expect(localHour(new Date('2026-09-20T18:30:00Z'), IST)).toBe(0)
  })

  it('is quiet from 22:00 through 07:59 IST and not otherwise', () => {
    expect(isQuietHour(new Date('2026-09-20T19:30:00Z'), IST, 22, 8)).toBe(true) // 01:00
    expect(isQuietHour(new Date('2026-09-20T16:30:00Z'), IST, 22, 8)).toBe(true) // 22:00
    expect(isQuietHour(new Date('2026-09-20T02:29:00Z'), IST, 22, 8)).toBe(true) // 07:59
    expect(isQuietHour(new Date('2026-09-20T02:30:00Z'), IST, 22, 8)).toBe(false) // 08:00
    expect(isQuietHour(new Date('2026-09-20T08:30:00Z'), IST, 22, 8)).toBe(false) // 14:00
  })

  it('supports a same-day window and can be disabled with start === end', () => {
    expect(isQuietHour(new Date('2026-09-20T08:30:00Z'), IST, 13, 15)).toBe(true) // 14:00
    expect(isQuietHour(new Date('2026-09-20T08:30:00Z'), IST, 0, 0)).toBe(false)
  })
})
