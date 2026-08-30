// ============================================================
// Structured logging — small helper for JSON-line output.
//
// Production: emits one JSON object per line, filterable via
// `railway logs | jq 'select(.event == "auto_reply.dispatched")'`
// or any log tail.
// Dev: emits a compact "level [event] key=value ..." line so
// terminal reading stays legible.
//
// Zero deps, zero side effects on module load. Not a replacement
// for console.log everywhere — start with the AI hot path and
// grow adoption gradually.
// ============================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogFields {
  [key: string]: unknown
}

/**
 * Fresh trace id for a single logical interaction. Format is a
 * short base36 timestamp + 6-char random so `trace_id=xy...`
 * greps well and doesn't dominate log lines.
 */
export function newTraceId(prefix = 'trc'): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${t}${r}`
}

function stringifyForDev(fields: LogFields): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    const str =
      typeof v === 'string'
        ? v.includes(' ')
          ? JSON.stringify(v)
          : v
        : v instanceof Error
          ? `${v.name}:${v.message}`
          : typeof v === 'object'
            ? JSON.stringify(v)
            : String(v)
    parts.push(`${k}=${str}`)
  }
  return parts.join(' ')
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  }
  if (process.env.NODE_ENV === 'production') {
    const line = JSON.stringify(record)
    // Route to the matching console channel so Railway's log
    // ingestion picks up level filtering; content stays JSON.
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  } else {
    const rest = stringifyForDev(fields)
    const line = `${level} [${event}]${rest ? ' ' + rest : ''}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
}

export const log = {
  debug: (event: string, fields: LogFields = {}) =>
    emit('debug', event, fields),
  info: (event: string, fields: LogFields = {}) =>
    emit('info', event, fields),
  warn: (event: string, fields: LogFields = {}) =>
    emit('warn', event, fields),
  error: (event: string, fields: LogFields = {}) =>
    emit('error', event, fields),
}
