// ============================================================
// GET /api/account/re-engagement/templates
//
// Returns the account's APPROVED WhatsApp templates so the
// re-engagement config UI can render a dropdown of valid choices.
//
// Marketing templates are the ONLY ones Meta allows outside the
// 24hr session window (which is what re-engagement is), but we
// return utility templates too — the operator picks; the server
// doesn't second-guess. A bad category is caught by Meta at send.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const { data, error } = await ctx.supabase
      .from('message_templates')
      .select('name, language, category, status')
      .eq('account_id', ctx.accountId)
      .in('status', ['APPROVED'])
      .order('name', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ templates: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
