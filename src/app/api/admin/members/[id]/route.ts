import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { supabaseAdmin } from '@/lib/auth/admin-client';
import { ALL_SCOPES, type Role, type Scope, type UserStatus } from '@/types';

const SCOPE_SET = new Set<string>(ALL_SCOPES);

interface PatchBody {
  role?: Role;
  status?: UserStatus;
  scopes?: Scope[];
}

/**
 * PATCH /api/admin/members/:id
 *
 * Admin-only. Updates a member's role / status / scopes. `:id` is the
 * profile row id (not the auth user id).
 *
 * Guard rails:
 *   * Admin cannot demote / disable themselves (would orphan the org).
 *   * Unknown scopes are rejected.
 *   * If role is set to 'admin', scopes are forced to [] — admins
 *     hold every scope implicitly and the array would just be noise.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as PatchBody | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const admin = supabaseAdmin();

  const { data: target, error: loadErr } = await admin
    .from('profiles')
    .select('id, user_id, role, status')
    .eq('id', id)
    .maybeSingle();
  if (loadErr || !target) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  }

  const isSelf = target.user_id === guard.profile.user_id;

  const patch: Record<string, unknown> = {};

  if (body.role !== undefined) {
    if (body.role !== 'admin' && body.role !== 'member') {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }
    if (isSelf && body.role !== 'admin') {
      return NextResponse.json(
        { error: 'You cannot demote yourself' },
        { status: 400 },
      );
    }
    patch.role = body.role;
  }

  if (body.status !== undefined) {
    if (!['pending', 'active', 'disabled'].includes(body.status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    if (isSelf && body.status !== 'active') {
      return NextResponse.json(
        { error: 'You cannot deactivate yourself' },
        { status: 400 },
      );
    }
    patch.status = body.status;
  }

  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes)) {
      return NextResponse.json({ error: 'scopes must be an array' }, { status: 400 });
    }
    const unknown = body.scopes.filter((s) => !SCOPE_SET.has(s));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: 'Unknown scopes', unknown },
        { status: 400 },
      );
    }
    patch.scopes = body.scopes;
  }

  // Admins hold every scope implicitly — clear the stored array so the
  // Members UI doesn't show stale per-scope toggles for them.
  const effectiveRole = (patch.role as Role | undefined) ?? (target.role as Role);
  if (effectiveRole === 'admin') {
    patch.scopes = [];
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No changes' }, { status: 400 });
  }

  const { data: updated, error: updateErr } = await admin
    .from('profiles')
    .update(patch)
    .eq('id', id)
    .select('id, user_id, full_name, email, avatar_url, role, status, scopes, created_at')
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? 'Update failed' },
      { status: 500 },
    );
  }
  return NextResponse.json({ member: updated });
}

/**
 * DELETE /api/admin/members/:id
 *
 * Hard-delete a member from auth.users (which cascades to profiles via
 * the FK in migration 001). Admins can't delete themselves. Prefer
 * `status='disabled'` if you want to revoke access while preserving the
 * audit trail on rows they own.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const admin = supabaseAdmin();

  const { data: target, error: loadErr } = await admin
    .from('profiles')
    .select('user_id')
    .eq('id', id)
    .maybeSingle();
  if (loadErr || !target) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  }
  if (target.user_id === guard.profile.user_id) {
    return NextResponse.json({ error: 'You cannot delete yourself' }, { status: 400 });
  }

  const { error: deleteErr } = await admin.auth.admin.deleteUser(target.user_id);
  if (deleteErr) {
    return NextResponse.json({ error: deleteErr.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
