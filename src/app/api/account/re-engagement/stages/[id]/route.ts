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

interface PatchBody {
  name?: unknown
  hours_after?: unknown
  template_name?: unknown
  template_language?: unknown
  template_type?: unknown
  enabled?: unknown
}

function parsePatch(raw: PatchBody | null): {
  ok: true
  value: Record<string, string | number | boolean>
} | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object')
    return { ok: false, error: 'body required' }
  const out: Record<string, string | number | boolean> = {}

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
    const t = raw.template_name.trim()
    if (!t) return { ok: false, error: 'template_name cannot be empty' }
    out.template_name = t
  }

  if (raw.template_language !== undefined) {
    if (typeof raw.template_language !== 'string')
      return { ok: false, error: 'template_language must be a string' }
    const l = raw.template_language.trim() || 'en'
    out.template_language = l
  }

  if (raw.template_type !== undefined) {
    if (raw.template_type !== 'text' && raw.template_type !== 'carousel')
      return { ok: false, error: "template_type must be 'text' or 'carousel'" }
    out.template_type = raw.template_type
  }

  if (raw.enabled !== undefined) {
    out.enabled = Boolean(raw.enabled)
  }

  if (Object.keys(out).length === 0)
    return { ok: false, error: 'nothing to update' }
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
    const parsed = parsePatch(raw)
    if (!parsed.ok)
      return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { data, error } = await ctx.supabase
      .from('re_engagement_stages')
      .update(parsed.value)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(
        'id, name, hours_after, template_name, template_language, template_type, enabled, created_at, updated_at',
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
