import { describe, expect, it } from 'vitest'
import { ID_CHUNK_SIZE, idChunks } from './id-chunks'

describe('idChunks', () => {
  it('returns no chunks for an empty list', () => {
    expect(idChunks([])).toEqual([])
  })

  it('splits into chunks of the given size, keeping order', () => {
    expect(idChunks(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('keeps every chunk at or under the default size', () => {
    const ids = Array.from({ length: 396 }, (_, i) => `id-${i}`)
    const chunks = idChunks(ids)
    expect(chunks.every((c) => c.length <= ID_CHUNK_SIZE)).toBe(true)
    expect(chunks.flat()).toEqual(ids)
  })
})
