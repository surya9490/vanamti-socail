import { describe, it, expect } from 'vitest'
import {
  matchOptOutKeyword,
  phoneSuffixKey,
  isPhoneOptedOut,
} from './opt-out'

describe('matchOptOutKeyword', () => {
  it('matches plain STOP in any case with punctuation', () => {
    expect(matchOptOutKeyword('STOP')).toBe('stop')
    expect(matchOptOutKeyword('stop')).toBe('stop')
    expect(matchOptOutKeyword('  Stop.  ')).toBe('stop')
    expect(matchOptOutKeyword('STOP!')).toBe('stop')
  })

  it('matches unsubscribe / opt out variants', () => {
    expect(matchOptOutKeyword('Unsubscribe')).toBe('stop')
    expect(matchOptOutKeyword('unsubscribe me')).toBe('stop')
    expect(matchOptOutKeyword('OPT OUT')).toBe('stop')
    expect(matchOptOutKeyword('opt-out')).toBe('stop')
    expect(matchOptOutKeyword('stop promotions')).toBe('stop')
  })

  it('matches START / resubscribe variants', () => {
    expect(matchOptOutKeyword('START')).toBe('start')
    expect(matchOptOutKeyword('Subscribe')).toBe('start')
    expect(matchOptOutKeyword('opt in')).toBe('start')
    expect(matchOptOutKeyword('resubscribe')).toBe('start')
  })

  it('does NOT match keywords embedded in longer sentences', () => {
    expect(matchOptOutKeyword("please don't stop my order")).toBeNull()
    expect(matchOptOutKeyword('when will my order start shipping')).toBeNull()
    expect(matchOptOutKeyword('the bus stop is far')).toBeNull()
    expect(matchOptOutKeyword('I want to stop by your farm')).toBeNull()
  })

  it('handles null / empty text', () => {
    expect(matchOptOutKeyword(null)).toBeNull()
    expect(matchOptOutKeyword(undefined)).toBeNull()
    expect(matchOptOutKeyword('')).toBeNull()
  })

  it('button payload wins over text and matches payload ids', () => {
    expect(matchOptOutKeyword('anything', 'optout')).toBe('stop')
    expect(matchOptOutKeyword(null, 'STOP_PROMOTIONS')).toBe('stop')
    expect(matchOptOutKeyword(null, 'opt_in')).toBe('start')
    expect(matchOptOutKeyword('stop', 'some_flow_button')).toBe('stop') // falls back to text
    expect(matchOptOutKeyword('hello', 'some_flow_button')).toBeNull()
  })
})

describe('phoneSuffixKey', () => {
  it('collapses country-code / trunk-prefix variants of an Indian number', () => {
    expect(phoneSuffixKey('+91 98765 43210')).toBe('9876543210')
    expect(phoneSuffixKey('919876543210')).toBe('9876543210')
    expect(phoneSuffixKey('09876543210')).toBe('9876543210')
    expect(phoneSuffixKey('9876543210')).toBe('9876543210')
  })

  it('keeps short numbers whole', () => {
    expect(phoneSuffixKey('12345678')).toBe('12345678')
  })
})

describe('isPhoneOptedOut', () => {
  const set = new Set([phoneSuffixKey('+919876543210')])

  it('matches any formatting variant of an opted-out number', () => {
    expect(isPhoneOptedOut(set, '919876543210')).toBe(true)
    expect(isPhoneOptedOut(set, '+91 98765-43210')).toBe(true)
    expect(isPhoneOptedOut(set, '09876543210')).toBe(true)
  })

  it('does not match other numbers', () => {
    expect(isPhoneOptedOut(set, '+919999999999')).toBe(false)
    expect(isPhoneOptedOut(new Set<string>(), '+919876543210')).toBe(false)
  })
})
