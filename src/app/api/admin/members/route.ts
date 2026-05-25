import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { supabaseAdmin } from '@/lib/auth/admin-client';

/**
 * GET /api/admin/members
 *
 * Lists every profile in the deployment — admins only. Used by the
 * Settings → Members tab.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('profiles')
    .select('id, user_id, full_name, email, avatar_url, role, status, scopes, created_at')
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ members: data ?? [] });
}
