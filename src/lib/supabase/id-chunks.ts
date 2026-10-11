// PostgREST puts `.in('col', ids)` in the request URL. A few hundred
// UUIDs overflow it and the fetch fails outright (~400 did in prod),
// so any id list that grows with the contact count must be split.
export const ID_CHUNK_SIZE = 100

export function idChunks<T>(ids: readonly T[], size = ID_CHUNK_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}
