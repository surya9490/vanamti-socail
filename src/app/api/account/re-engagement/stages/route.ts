// ============================================================
// GET  /api/account/re-engagement/stages
//   List every stage for the caller's account, oldest→newest by
//   hours_after (matches the order the cron evaluates them in).
//
// POST /api/account/re-engagement/stages
//   Create a stage. Admin+ only. Body:
//     { name, hours_after, template_name, template_language?,
//       template_type?, enabled? }
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

const MAX_STAGES_PER_ACCOUNT = 20

interface CreateBody {
  name?: unknown
  hours_after?: unknown
  template_name?: unknown
  template_language?: unknown
  template_type?: unknown
  enabled?: unknown
}

function parseCreate(raw: CreateBody | null): {
  ok: true
  value: {
    name: string
    hours_after: number
    template_name: string
    template_language: string
    template_type: 'text' | 'carousel'
    enabled: boolean
  }
} | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body required' }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) return { ok: false, error: 'name is required' }
  if (name.length > 80) return { ok: false, error: 'name too long (max 80)' }

  const hours = Number(raw.hours_after)
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isInteger(hours))
    return { ok: false, error: 'hours_after must be a positive integer' }
  if (hours > 24 * 365)
    return { ok: false, error: 'hours_after too large (max 1 year)' }

  const templateName =
    typeof raw.template_name === 'string' ? raw.template_name.trim() : ''
  if (!templateName) return { ok: false, error: 'template_name is required' }

  const templateLang =
    typeof raw.template_language === 'string' && raw.template_language.trim()
      ? raw.template_language.trim()
      : 'en'

  const templateType =
    raw.template_type === 'carousel' ? 'carousel' : 'text'

  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled)

  return {
    ok: true,
    value: {
      name,
      hours_after: hours,
      template_name: templateName,
      template_language: templateLang,
      template_type: templateType,
      enabled,
    },
  }
}

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const { data, error } = await ctx.supabase
      .from('re_engagement_stages')
      .select(
        'id, name, hours_after, template_name, template_language, template_type, enabled, created_at, updated_at',
      )
      .eq('account_id', ctx.accountId)
      .order('hours_after', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ stages: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const raw = (await request.json().catch(() => null)) as CreateBody | null
    const parsed = parseCreate(raw)
    if (!parsed.ok)
      return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { count } = await ctx.supabase
      .from('re_engagement_stages')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId)
    if ((count ?? 0) >= MAX_STAGES_PER_ACCOUNT) {
      return NextResponse.json(
        { error: `Maximum ${MAX_STAGES_PER_ACCOUNT} stages per account` },
        { status: 400 },
      )
    }

    const { data, error } = await ctx.supabase
      .from('re_engagement_stages')
      .insert({ account_id: ctx.accountId, ...parsed.value })
      .select(
        'id, name, hours_after, template_name, template_language, template_type, enabled, created_at, updated_at',
      )
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ stage: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
