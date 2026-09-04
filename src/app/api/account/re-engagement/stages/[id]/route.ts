// ============================================================
// PATCH  /api/account/re-engagement/stages/[id]  Admin+
//   Partial update — any subset of {name, hours_after,
//   template_name, template_language, template_type, enabled}.
//
// DELETE /api/account/re-engagement/stages/[id]  Admin+
//   Also cascades away the contact_re_engagement_sends idempotency
//   rows for that stage (foreign-key ON DELETE CASCADE).
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

type StageType = 'text' | 'carousel' | 'catalog' | 'freeform_text'
const IN_SESSION_TYPES: StageType[] = ['catalog', 'freeform_text']
const SESSION_WINDOW_HOURS = 24

interface PatchBody {
  name?: unknown
  hours_after?: unknown
  template_name?: unknown
  template_language?: unknown
  template_type?: unknown
  custom_text?: unknown
  enabled?: unknown
}

interface ExistingStage {
  hours_after: number
  template_type: StageType
  custom_text: string | null
}

function parsePatch(
  raw: PatchBody | null,
  existing: ExistingStage,
): {
  ok: true
  value: Record<string, string | number | boolean | null>
} | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object')
    return { ok: false, error: 'body required' }
  const out: Record<string, string | number | boolean | null> = {}

  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') return { ok: false, error: 'name must be a string' }
    const trimmed = raw.name.trim()
    if (!trimmed) return { ok: false, error: 'name cannot be empty' }
    if (trimmed.length > 80) return { ok: false, error: 'name too long (max 80)' }
    out.name = trimmed
  }

  if (raw.hours_after !== undefined) {
    const h = Number(raw.hours_after)
    if (!Number.isFinite(h) || h <= 0 || !Number.isInteger(h))
      return { ok: false, error: 'hours_after must be a positive integer' }
    if (h > 24 * 365)
      return { ok: false, error: 'hours_after too large (max 1 year)' }
    out.hours_after = h
  }

  if (raw.template_name !== undefined) {
    if (typeof raw.template_name !== 'string')
      return { ok: false, error: 'template_name must be a string' }
    out.template_name = raw.template_name.trim()
  }

  if (raw.template_language !== undefined) {
    if (typeof raw.template_language !== 'string')
      return { ok: false, error: 'template_language must be a string' }
    out.template_language = raw.template_language.trim() || 'en'
  }

  if (raw.template_type !== undefined) {
    if (
      raw.template_type !== 'text' &&
      raw.template_type !== 'carousel' &&
      raw.template_type !== 'catalog' &&
      raw.template_type !== 'freeform_text'
    )
      return { ok: false, error: "template_type must be one of text|carousel|catalog|freeform_text" }
    out.template_type = raw.template_type
  }

  if (raw.custom_text !== undefined) {
    if (raw.custom_text === null || raw.custom_text === '') {
      out.custom_text = null
    } else {
      if (typeof raw.custom_text !== 'string')
        return { ok: false, error: 'custom_text must be a string' }
      const t = raw.custom_text.trim()
      if (t.length > 1000)
        return { ok: false, error: 'custom_text too long (max 1000 chars)' }
      out.custom_text = t
    }
  }

  if (raw.enabled !== undefined) {
    out.enabled = Boolean(raw.enabled)
  }

  if (Object.keys(out).length === 0)
    return { ok: false, error: 'nothing to update' }

  // Cross-field checks: resolve the effective final row and enforce
  // the in-session rule + freeform-text needs a body.
  const finalType = (out.template_type as StageType | undefined) ?? existing.template_type
  const finalHours =
    typeof out.hours_after === 'number' ? out.hours_after : existing.hours_after
  const finalText =
    out.custom_text === undefined
      ? existing.custom_text
      : (out.custom_text as string | null)

  if (IN_SESSION_TYPES.includes(finalType) && finalHours >= SESSION_WINDOW_HOURS) {
    return {
      ok: false,
      error: `${finalType === 'catalog' ? 'Product catalog' : 'Freeform text'} stages must fire within 24h — set hours_after below 24 or change the type.`,
    }
  }
  if (finalType === 'freeform_text' && !finalText) {
    return { ok: false, error: 'Freeform text stages need a message body.' }
  }

  return { ok: true, value: out }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const raw = (await request.json().catch(() => null)) as PatchBody | null

    // Load existing so cross-field validation (in-session rule,
    // freeform-body requirement) can consider the merged final row.
    const { data: existing, error: existingErr } = await ctx.supabase
      .from('re_engagement_stages')
      .select('hours_after, template_type, custom_text')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (existingErr)
      return NextResponse.json({ error: existingErr.message }, { status: 500 })
    if (!existing)
      return NextResponse.json({ error: 'stage not found' }, { status: 404 })

    const parsed = parsePatch(raw, existing as ExistingStage)
    if (!parsed.ok)
      return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { data, error } = await ctx.supabase
      .from('re_engagement_stages')
      .update(parsed.value)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(
        'id, name, hours_after, template_name, template_language, template_type, custom_text, enabled, created_at, updated_at',
      )
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data)
      return NextResponse.json({ error: 'stage not found' }, { status: 404 })
    return NextResponse.json({ stage: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const { error } = await ctx.supabase
      .from('re_engagement_stages')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
