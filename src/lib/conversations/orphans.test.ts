import { describe, it, expect } from 'vitest'
import { isOrphanContact } from './orphans'

const base = {
  name: '919944633893',
  phone: '919944633893',
  remainingConversations: 0,
  tags: 0,
  broadcastRecipients: 0,
}

describe('isOrphanContact', () => {
  it('deletes an API stub: name == phone, nothing attached', () => {
    expect(isOrphanContact(base)).toBe(true)
  })

  it('treats name formatting differences as the same phone (+91 / spaces)', () => {
    expect(isOrphanContact({ ...base, name: '+91 99446 33893' })).toBe(true)
  })

  it('deletes when the name is empty / null', () => {
    expect(isOrphanContact({ ...base, name: '' })).toBe(true)
    expect(isOrphanContact({ ...base, name: null })).toBe(true)
  })

  it('KEEPS a contact someone actually named', () => {
    expect(isOrphanContact({ ...base, name: 'Surya Kiran' })).toBe(false)
  })

  it('KEEPS a contact with any other conversation', () => {
    expect(isOrphanContact({ ...base, remainingConversations: 1 })).toBe(false)
  })

  it('KEEPS a tagged contact', () => {
    expect(isOrphanContact({ ...base, tags: 1 })).toBe(false)
  })

  it('KEEPS a contact with broadcast history', () => {
    expect(isOrphanContact({ ...base, broadcastRecipients: 1 })).toBe(false)
  })

  it('KEEPS a contact whose "name" is a DIFFERENT number (not an auto-default)', () => {
    expect(isOrphanContact({ ...base, name: '919999999999' })).toBe(false)
  })
})
