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

  it('detects address_ask for the "need the state" clarifier', () => {
    // Real prod case: customer gave partial address; bot asked for
    // the missing state field. The nudge must still fire off this
    // follow-up ask if the customer goes silent again.
    expect(
      detectCloseStage(
        'Perfect! Just need the state to complete this — what state is that?',
      ),
    ).toBe('address_ask')
  })

  it('detects address_ask for other missing-field clarifiers', () => {
    expect(detectCloseStage('What state are you in?')).toBe('address_ask')
    expect(detectCloseStage('Could you share your pincode?')).toBe('address_ask')
    expect(detectCloseStage('Which city are we delivering to?')).toBe(
      'address_ask',
    )
    expect(detectCloseStage('Can you share your line 1?')).toBe('address_ask')
  })

  it('does NOT re-match our own address-ask nudge bodies (anti-loop guarantee)', () => {
    // These are the EXACT nudge messages the cron sends. Both must
    // return null so a nudge can never re-trigger another one — even
    // if the message_id de-dupe misses.
    expect(
      detectCloseStage(
        "Still there? Ready when you are — just share your name, address, city, state, and pincode and I'll get this shipped 🌿",
      ),
    ).toBeNull()
    expect(
      detectCloseStage(
        "No rush 🙏 Whenever you're ready, share your address and I'll create the payment link.",
      ),
    ).toBeNull()
  })

  it('detects catalog_sent for the bot\'s catalog-follow-up phrasing', () => {
    // These are what the AI sends after a catalog Multi-Product
    // Message — customer often goes silent right here (browsing).
    expect(
      detectCloseStage(
        "Here's what we have at Vanamati — tap any product to see details 🌿",
      ),
    ).toBe('catalog_sent')
    expect(
      detectCloseStage(
        'Namaste Jayaseelan! 🌿 Take a look at our range above — tap any product for details, and let me know if you have questions or want to order!',
      ),
    ).toBe('catalog_sent')
    expect(
      detectCloseStage(
        'Here you go, Surya — tap any product to see details 🌿',
      ),
    ).toBe('catalog_sent')
  })

  it('detects catalog_sent when the bot lists the range as a TEXT price list', () => {
    // The fallback shape the AI uses instead of the catalog card —
    // seen live 2026-09-20: customer said "I have a question", the
    // bot replied with the range, customer went silent, no nudge.
    expect(
      detectCloseStage(
        "Namaste Priya! 🌿 Sure, go ahead — what would you like to know? Here's a quick look at our range meanwhile:\n\n• Iyappa Ghee – ₹349 (250ml)\n• A2 Cow Ghee (Bilona) – ₹599 (250ml)\n• Forest Honey (Coorg) – ₹549 (250ml)\n• Acacia Honey – ₹399 (250ml)\n• Multifloral Honey – ₹349 (250ml)\n\nAll FSSAI certified, lab-tested, with free shipping on every order. Let me know which one you'd like details on!",
      ),
    ).toBe('catalog_sent')
    // Bullets only, no opener phrasing.
    expect(
      detectCloseStage(
        'Here are a few options:\n- Forest Honey 250ml — ₹549\n- Acacia Honey 250ml — ₹399\n- Multifloral Honey 250ml — ₹349',
      ),
    ).toBe('catalog_sent')
    // Numbered list, blank lines between items.
    expect(
      detectCloseStage(
        '1. Iyappa Ghee ₹349\n\n2. A2 Ghee ₹599\n\n3. Forest Honey ₹549',
      ),
    ).toBe('catalog_sent')
    // Closer phrasing alone.
    expect(
      detectCloseStage('Let me know which one you\'d like details on 🌿'),
    ).toBe('catalog_sent')
  })

  it('does NOT treat a single price or a two-item list as the range', () => {
    expect(detectCloseStage('Forest Honey 500ml is ₹999 🍯')).toBeNull()
    expect(
      detectCloseStage('• Forest Honey – ₹549\n• Acacia Honey – ₹399'),
    ).toBeNull()
  })

  it('keeps an order summary with prices out of catalog_sent', () => {
    expect(
      detectCloseStage(
        "Here's your order summary:\n• A2 Cow Ghee 250ml – ₹599\n• Forest Honey 250ml – ₹549\n• Shipping – ₹0\nTotal: ₹1,148. Shall I go ahead?",
      ),
    ).toBeNull()
    // The standard phrasing still resolves to the closer stage.
    expect(
      detectCloseStage(
        'Let me confirm your order:\n• A2 Cow Ghee 250ml – ₹599\n• Forest Honey 250ml – ₹549\n• Acacia Honey – ₹399\nReady to create your payment link?',
      ),
    ).toBe('address_confirm')
  })

  it('does NOT re-match our own catalog_sent nudge bodies (anti-loop)', () => {
    // Both nudge messages the catalog_sent stage sends. Anti-loop.
    expect(
      detectCloseStage(
        "Take your time 🌿 If any of them caught your eye or you'd like a suggestion, I'm right here to help you pick.",
      ),
    ).toBeNull()
    expect(
      detectCloseStage(
        "If you're still deciding — a great place to start is our A2 Cow Ghee (customer favourite 🍯). Or tell me what you're looking for and I'll point you to the right one.",
      ),
    ).toBeNull()
  })

  it('when a bot text is BOTH catalog and address-ask, address-ask wins', () => {
    // Contrived: an AI message that combines both cues. Address-ask
    // is closer to close, so it should win.
    expect(
      detectCloseStage(
        "Here's what we have — tap any product. Also please share your full name, address (line 1 + area), city, state, and 6-digit pincode.",
      ),
    ).toBe('address_ask')
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
