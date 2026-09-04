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

type StageType = 'text' | 'carousel' | 'catalog' | 'freeform_text'

const IN_SESSION_TYPES: StageType[] = ['catalog', 'freeform_text']
const SESSION_WINDOW_HOURS = 24

interface CreateBody {
  name?: unknown
  hours_after?: unknown
  template_name?: unknown
  template_language?: unknown
  template_type?: unknown
  custom_text?: unknown
  enabled?: unknown
}

function parseType(raw: unknown): StageType {
  if (raw === 'carousel' || raw === 'catalog' || raw === 'freeform_text')
    return raw
  return 'text'
}

function parseCreate(raw: CreateBody | null): {
  ok: true
  value: {
    name: string
    hours_after: number
    template_name: string
    template_language: string
    template_type: StageType
    custom_text: string | null
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

  const templateType = parseType(raw.template_type)

  // In-session types (catalog / freeform_text) only work inside
  // WhatsApp's 24h session window — reject an operator that sets
  // hours_after >= 24 with these types. It's a hard rule at Meta,
  // not a preference — sending catalog/freeform outside 24h fails.
  if (IN_SESSION_TYPES.includes(templateType) && hours >= SESSION_WINDOW_HOURS) {
    return {
      ok: false,
      error: `${templateType === 'catalog' ? 'Product catalog' : 'Freeform text'} stages must fire within 24h of the customer's last message. Set hours_after to less than 24, or pick a Meta template type for later stages.`,
    }
  }

  // Template name is only meaningful for the two template types;
  // stored as empty string when the type doesn't need it.
  const needsTemplateName = templateType === 'text' || templateType === 'carousel'
  const templateName =
    typeof raw.template_name === 'string' ? raw.template_name.trim() : ''
  if (needsTemplateName && !templateName)
    return { ok: false, error: 'template_name is required for template types' }

  const templateLang =
    typeof raw.template_language === 'string' && raw.template_language.trim()
      ? raw.template_language.trim()
      : 'en'

  // custom_text is required for freeform_text (that's the whole body).
  const customText =
    typeof raw.custom_text === 'string' ? raw.custom_text.trim() : ''
  if (templateType === 'freeform_text') {
    if (!customText)
      return { ok: false, error: 'Freeform text stages need a message body (custom_text).' }
    if (customText.length > 1000)
      return { ok: false, error: 'custom_text too long (max 1000 chars — WhatsApp caps freeform text)' }
  }

  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled)

  return {
    ok: true,
    value: {
      name,
      hours_after: hours,
      template_name: needsTemplateName ? templateName : '',
      template_language: templateLang,
      template_type: templateType,
      custom_text: customText || null,
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
        'id, name, hours_after, template_name, template_language, template_type, custom_text, enabled, created_at, updated_at',
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
        'id, name, hours_after, template_name, template_language, template_type, custom_text, enabled, created_at, updated_at',
      )
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ stage: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
