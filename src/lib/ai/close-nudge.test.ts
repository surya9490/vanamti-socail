import { describe, it, expect } from 'vitest'
import { detectCloseStage, pickNextNudge } from './close-nudge'

describe('detectCloseStage', () => {
  it('returns null for null / empty / whitespace', () => {
    expect(detectCloseStage(null)).toBeNull()
    expect(detectCloseStage(undefined)).toBeNull()
    expect(detectCloseStage('')).toBeNull()
    expect(detectCloseStage('   ')).toBeNull()
  })

  it('returns null for irrelevant chit-chat', () => {
    expect(detectCloseStage('Namaste! How can I help?')).toBeNull()
    expect(
      detectCloseStage("We're open 9am-6pm Monday to Saturday."),
    ).toBeNull()
    expect(detectCloseStage('Forest Honey is our best seller 🍯')).toBeNull()
  })

  it('detects address_ask for the standard prompt phrasing', () => {
    expect(
      detectCloseStage(
        "Let's get this shipped to you — please share your full name, address (line 1 + area), city, state, and 6-digit pincode.",
      ),
    ).toBe('address_ask')
  })

  it('detects address_ask for the numbered-list phrasing', () => {
    expect(
      detectCloseStage(
        'Please share: full name, address, city, state and pincode.',
      ),
    ).toBe('address_ask')
  })

  it('detects address_confirm for the "let me confirm" summary', () => {
    expect(
      detectCloseStage(
        'Thanks! Let me confirm your full delivery address: Name: Lakshmikanthan, Address: RCS main Road, Natrampalli, Tamil Nadu - 635852. Ready to create your payment link?',
      ),
    ).toBe('address_confirm')
  })

  it('detects address_confirm for the "Confirming your order" phrasing', () => {
    expect(
      detectCloseStage(
        'Perfect! Confirming your order — A2 Cow Ghee 500ml × 1, ₹1099. Deliver to: ... Ready for me to create the payment link?',
      ),
    ).toBe('address_confirm')
  })

  it('detects payment_link_sent for a Vanamati invoice URL (no trailing slash)', () => {
    expect(
      detectCloseStage(
        "Here's your payment link — tap to complete payment and I'll get this shipped 🍯 → https://vanamati.com/74506633351/invoices/1aad9cad575d35b1475d71a8561b57d6",
      ),
    ).toBe('payment_link_sent')
  })

  it('detects payment_link_sent for a myshopify checkout URL', () => {
    expect(
      detectCloseStage(
        'Complete payment here: https://j7w7ue-0v.myshopify.com/12345/checkouts/xyz',
      ),
    ).toBe('payment_link_sent')
  })

  it('does NOT detect payment_link_sent for the bare phrase "payment link" without a URL', () => {
    // Confirmation asks ("Ready to create your payment link?")
    // mention the phrase but aren't a link send — must fall
    // through to address_confirm (or null when no URL is present
    // and no confirm phrasing either).
    expect(
      detectCloseStage("Here's your payment link: (link generation in progress)"),
    ).toBeNull()
  })

  it('prefers payment_link_sent over address_confirm when BOTH match', () => {
    // Combined final message — payment link out but also mentions
    // "confirming your order" as a summary. The URL wins because
    // we're now past the confirm step.
    expect(
      detectCloseStage(
        'Confirming your order — A2 Ghee 500ml. Your payment link: https://vanamati.com/74506633351/invoices/abc',
      ),
    ).toBe('payment_link_sent')
  })

  it('prefers address_confirm over address_ask when BOTH could match', () => {
    // Confirm messages often also mention "address" and "pincode" as
    // part of the summary body — the confirm regex must win.
    expect(
      detectCloseStage(
        'Thanks! Let me confirm your full delivery address including pincode 635852. Ready to create your payment link?',
      ),
    ).toBe('address_confirm')
  })
})

describe('pickNextNudge', () => {
  it('returns the first nudge when none have been sent', () => {
    const n = pickNextNudge('address_ask', 0)
    expect(n).not.toBeNull()
    expect(n?.nudgeNumber).toBe(1)
    expect(n?.minutesAfter).toBe(1)
    expect(n?.message).toMatch(/still there|share your name|address/i)
  })

  it('returns the second nudge after one already sent', () => {
    const n = pickNextNudge('address_confirm', 1)
    expect(n).not.toBeNull()
    expect(n?.nudgeNumber).toBe(2)
    expect(n?.minutesAfter).toBe(3)
  })

  it('caps at the per-stage max (returns null past the last nudge)', () => {
    expect(pickNextNudge('address_ask', 2)).toBeNull()
    expect(pickNextNudge('address_confirm', 2)).toBeNull()
    expect(pickNextNudge('payment_link_sent', 2)).toBeNull()
  })

  it('uses payment_link_sent slower cadence (3 min, 10 min)', () => {
    expect(pickNextNudge('payment_link_sent', 0)?.minutesAfter).toBe(3)
    expect(pickNextNudge('payment_link_sent', 1)?.minutesAfter).toBe(10)
  })
})
