import { describe, it, expect } from 'vitest'
import { customerDeclined, isBareAcknowledgment, isClosingAckTurn, isDecline, type RecentMessage } from './closing'

const customer = (contentText: string, contentType = 'text'): RecentMessage => ({ senderType: 'customer', contentType, contentText })
const bot = (contentText: string, contentType = 'text'): RecentMessage => ({ senderType: 'bot', contentType, contentText })
const agent = (contentText: string): RecentMessage => ({ senderType: 'agent', contentType: 'text', contentText })

describe('isBareAcknowledgment', () => {
  it('recognises the acknowledgments customers actually send', () => {
    for (const t of [
      'Ok', 'ok', 'Okay sir', '.ok sir', 'Ok.', 'k', 'kk', 'Thanks', 'Thanks 👍', 'thankyou', 'Thank you',
      'ok thank you sir.', 'Ok thank you', 'sure thank u', 'thank u', 'thank you 👍😊', 'Thank you so much',
      '👍🏻', '👍🏻👍🏻', '👍🙏', '🙏', 'ok mam', 'Ji', 'Noted', 'Fine', 'tq', 'Ty',
    ]) {
      expect(isBareAcknowledgment(t), t).toBe(true)
    }
  })

  it('anything that says more is not one', () => {
    for (const t of [
      'yes', 'Yes please', 'no', 'Very good....👍', 'received ghee, thank you.', 'received with thanks',
      'After  I. send more arder', 'ok send catalog', 'ok?', 'ok 😡', 'thanks, where is my order', 'Hi', '', '   ',
      'No thank you for quick response. Really appreciate it.',
    ]) {
      expect(isBareAcknowledgment(t), t).toBe(false)
    }
    expect(isBareAcknowledgment(null)).toBe(false)
  })
})

describe('isClosingAckTurn (newest first)', () => {
  it('replays 2026-10-13 (#vana1153 buyer): one courtesy reply, then silence for each "Ok" / "Thanks"', () => {
    // First "Thanks 👍" after the photo: nothing of ours yet → reply once.
    expect(isClosingAckTurn([customer('Thanks 👍'), customer('', 'image')])).toBe(false)
    const welcome = bot("You're welcome! 🌿 Do reach out whenever you need anything.")
    expect(isClosingAckTurn([customer('Ok'), welcome, customer('Thanks 👍'), customer('', 'image')])).toBe(true)
    expect(isClosingAckTurn([customer('Thanks'), customer('Ok'), welcome])).toBe(true)
    // A real message still gets answered…
    expect(isClosingAckTurn([customer('After  I. send more arder'), customer('Ok'), welcome])).toBe(false)
    // …and the "Ok" after that answer doesn't.
    expect(
      isClosingAckTurn([
        customer('Ok'),
        bot("Sure! Whenever you're ready to place another order, just let me know what you'd like and I'll set it up for you 🌿"),
      ]),
    ).toBe(true)
  })

  it('an "ok" to a question is an answer — reply', () => {
    expect(isClosingAckTurn([customer('ok'), bot('Would you like the 500ml or the 1L jar?')])).toBe(false)
    expect(isClosingAckTurn([customer('Ok'), bot('Ready to create your payment link?')])).toBe(false)
  })

  it('an "ok" at a checkout step or after a catalog moves the sale forward — reply', () => {
    expect(
      isClosingAckTurn([
        customer('ok'),
        bot('Please share your full name, address (line 1 + area), city, state, and 6-digit pincode.'),
      ]),
    ).toBe(false)
    expect(
      isClosingAckTurn([customer('ok'), bot('Pay here: https://shop.vanamati.com/123/invoices/abc')]),
    ).toBe(false)
    expect(isClosingAckTurn([customer('ok'), bot("Here's what we make at Vanamati", 'interactive')])).toBe(false)
  })

  it('stays quiet on a "thanks" after an order update or an agent note', () => {
    expect(
      isClosingAckTurn([
        customer('thanks'),
        { senderType: 'agent', contentType: 'template', contentText: 'Hi Iswarya, your order #vana1061 has been dispatched.' },
      ]),
    ).toBe(true)
    expect(isClosingAckTurn([customer('👍🙏'), agent('secondary number: 9019252763')])).toBe(true)
  })

  it('a photo or voice note in the turn is never "just an ack"', () => {
    expect(isClosingAckTurn([customer('', 'audio'), customer('Ok'), bot('Take care!')])).toBe(false)
    expect(isClosingAckTurn([customer('Thanks'), customer('', 'image'), bot('Take care!')])).toBe(false)
  })

  it('nothing to go on → reply', () => {
    expect(isClosingAckTurn([])).toBe(false)
    expect(isClosingAckTurn([bot('Take care!')])).toBe(false)
  })
})

describe('isDecline', () => {
  it('a clear no', () => {
    for (const t of [
      'Not interested', 'not intrested sir', 'I am not interested in this', 'no thanks', 'No thank you', 'No, thank you sir',
      "I don't want", 'dont need', 'no need', 'Not now', 'not required', 'stop', 'STOP',
      'Please stop sending messages', "don't message me", 'unsubscribe', 'remove my number',
      'vendam', 'Vendaam sir', 'வேண்டாம்', 'nahi chahiye', 'नहीं चाहिए', 'beda',
    ]) {
      expect(isDecline(t), t).toBe(true)
    }
  })

  it('not a no — answers, thanks, and remarks about the order itself', () => {
    for (const t of [
      'No thank you for quick response. Really appreciate it.',
      'no', 'No', 'no no it is not nice', 'ok', 'yes',
      "I don't want the 500ml, send 1L", '1kg vendam, 500g podhum', 'no need 2 jars, 1 is enough',
      'send by dtdc or blue dart', 'send again by dtdc', "don't send by professional courier, it never comes",
      'this time i will not get', 'Is COD available?',
    ]) {
      expect(isDecline(t), t).toBe(false)
    }
  })
})

describe('customerDeclined (newest first)', () => {
  it('the newest message with something to say decides; trailing acks keep the no', () => {
    expect(customerDeclined(['ok', 'Not interested'])).toBe(true)
    expect(customerDeclined(['Thanks 👍', 'ok', 'no thanks'])).toBe(true)
    expect(customerDeclined(['actually show me the ghee', 'not interested'])).toBe(false)
    expect(customerDeclined(['ok', 'thanks'])).toBe(false)
    expect(customerDeclined([])).toBe(false)
  })
})
