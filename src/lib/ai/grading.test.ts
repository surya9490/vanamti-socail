import { describe, it, expect } from 'vitest'
import { extractGrade, nextGrade, type LeadStage } from './grading'

describe('extractGrade', () => {
  it('returns { grade: null, text: "" } for empty input', () => {
    expect(extractGrade('')).toEqual({ grade: null, text: '' })
  })

  it('returns null grade when no tag present', () => {
    const raw = 'Hello! We have Forest Honey (Coorg) at ₹549.'
    expect(extractGrade(raw)).toEqual({ grade: null, text: raw })
  })

  it('extracts hot / warm / cold and strips the tag', () => {
    for (const grade of ['hot', 'warm', 'cold'] as const) {
      const raw = `Sure! Here you go.\n<GRADE>${grade}</GRADE>`
      const result = extractGrade(raw)
      expect(result.grade).toBe(grade)
      expect(result.text).toBe('Sure! Here you go.')
    }
  })

  it('is case-insensitive on both tag and value', () => {
    expect(extractGrade('reply <grade>HOT</grade>').grade).toBe('hot')
    expect(extractGrade('reply <GRADE>Warm</GRADE>').grade).toBe('warm')
    expect(extractGrade('reply <Grade>cOLD</Grade>').grade).toBe('cold')
  })

  it('tolerates whitespace inside the tag', () => {
    expect(extractGrade('reply <GRADE>  hot  </GRADE>').grade).toBe('hot')
  })

  it('strips multiple grade tags (buggy model output)', () => {
    const raw = 'text <GRADE>warm</GRADE> more <GRADE>hot</GRADE>'
    const result = extractGrade(raw)
    // First match wins for the grade value.
    expect(result.grade).toBe('warm')
    // All grade tags are stripped from the customer-facing text.
    expect(result.text).not.toContain('<GRADE>')
    expect(result.text).not.toContain('</GRADE>')
  })

  it('trims leading/trailing whitespace after strip', () => {
    expect(extractGrade('\n\n<GRADE>hot</GRADE>\n').text).toBe('')
  })

  it('leaves an unrecognised value as no-grade and does not strip', () => {
    const raw = 'reply <GRADE>lukewarm</GRADE>'
    const result = extractGrade(raw)
    expect(result.grade).toBeNull()
    // Only recognised tags are stripped; a malformed one stays put
    // so a human agent notices something weird in the output.
    expect(result.text).toBe(raw)
  })
})

describe('nextGrade (ratchet)', () => {
  const stages: LeadStage[] = ['cold', 'warm', 'hot']

  it('returns null when the new grade is null', () => {
    for (const s of stages) expect(nextGrade(s, null)).toBeNull()
    expect(nextGrade(null, null)).toBeNull()
  })

  it('adopts any new grade when no current grade', () => {
    for (const s of stages) expect(nextGrade(null, s)).toBe(s)
  })

  it('upgrades cold → warm and cold → hot', () => {
    expect(nextGrade('cold', 'warm')).toBe('warm')
    expect(nextGrade('cold', 'hot')).toBe('hot')
  })

  it('upgrades warm → hot', () => {
    expect(nextGrade('warm', 'hot')).toBe('hot')
  })

  it('no-op when new equals current', () => {
    for (const s of stages) expect(nextGrade(s, s)).toBeNull()
  })

  it('does NOT downgrade hot → warm, hot → cold, warm → cold', () => {
    expect(nextGrade('hot', 'warm')).toBeNull()
    expect(nextGrade('hot', 'cold')).toBeNull()
    expect(nextGrade('warm', 'cold')).toBeNull()
  })
})
