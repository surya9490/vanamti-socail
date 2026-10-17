// ============================================================
// GET /api/v1/templates — the account's WhatsApp message templates.
//
// What each template says — header, body with its {{n}} slots,
// footer, buttons — and whether Meta approved it, so an integrator
// can show a message the way the customer will see it before
// sending it. Needs `messages:send`: whoever may send a template
// may read it.
//
// `?name=a&name=b` narrows to those names (up to 50); without it,
// every template on the account.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';

interface TemplateRow {
  name: string;
  language: string | null;
  category: string | null;
  status: string | null;
  header_type: string | null;
  header_content: string | null;
  body_text: string;
  footer_text: string | null;
  buttons: unknown;
  updated_at: string | null;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');
    const names = new URL(request.url).searchParams
      .getAll('name')
      .map((n) => n.trim())
      .filter(Boolean)
      .slice(0, 50);

    let query = ctx.supabase
      .from('message_templates')
      .select('name, language, category, status, header_type, header_content, body_text, footer_text, buttons, updated_at')
      .eq('account_id', ctx.accountId)
      .order('name');
    if (names.length > 0) query = query.in('name', names);

    const { data, error } = await query;
    if (error) throw error;

    return ok({
      templates: ((data ?? []) as TemplateRow[]).map((row) => ({
        name: row.name,
        language: row.language,
        category: row.category,
        status: row.status,
        header: row.header_type ? { type: row.header_type, content: row.header_content } : null,
        body: row.body_text,
        footer: row.footer_text,
        buttons: Array.isArray(row.buttons) ? row.buttons : [],
        updatedAt: row.updated_at,
      })),
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
