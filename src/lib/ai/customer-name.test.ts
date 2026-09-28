import { describe, it, expect } from 'vitest'
import { displayNameForPrompt } from './customer-name'

describe('displayNameForPrompt', () => {
  it.each(['Zakir Hussain', 'Sumathy Sathyaseelan', 'Priya', 'SUMATHY', 'Dr Prabhakar M', 'Iswarya'])('keeps %s', (n) =>
    expect(displayNameForPrompt(n)).toBe(n),
  )
  it.each(['crspingalay', 'karthik army07', 'sg_ganesh', 'quiet.harbor503+vanamati.com@ilovemyemail.net', '+91 98412 92592', '', '   ', null, undefined])(
    'drops %s',
    (n) => expect(displayNameForPrompt(n)).toBeNull(),
  )
})
