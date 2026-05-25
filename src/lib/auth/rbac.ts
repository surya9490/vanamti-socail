import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import type { Role, Scope, UserStatus } from '@/types';

/**
 * Server-side RBAC helpers for API route handlers.
 *
 * RLS in Postgres is the source of truth — any query a non-active user
 * runs returns empty, any insert fails. These helpers add a clearer
 * error response (401 / 403) before the query is even attempted, and
 * make role/scope intent obvious in each handler.
 *
 * Service-role callers (webhook ingest, automation runner, flow runner)
 * use supabaseAdmin() directly and bypass RLS — they should not use
 * these helpers.
 */

export interface ActiveProfile {
  user_id: string;
  role: Role;
  status: UserStatus;
  scopes: Scope[];
}

type Guard =
  | { ok: true; profile: ActiveProfile }
  | { ok: false; response: NextResponse };

async function loadProfile(): Promise<Guard> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, role, status, scopes')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, response: NextResponse.json({ error: 'Profile not found' }, { status: 403 }) };
  }
  const profile: ActiveProfile = {
    user_id: data.user_id,
    role: data.role as Role,
    status: data.status as UserStatus,
    scopes: (data.scopes ?? []) as Scope[],
  };
  if (profile.status !== 'active') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: profile.status === 'pending' ? 'Account pending approval' : 'Account disabled' },
        { status: 403 },
      ),
    };
  }
  return { ok: true, profile };
}

/**
 * Require the caller to hold at least one of `scopes`. Admins pass
 * unconditionally. Returns the resolved profile on success, or a 401/403
 * NextResponse the handler should return directly.
 */
export async function requireScope(...scopes: Scope[]): Promise<Guard> {
  const result = await loadProfile();
  if (!result.ok) return result;
  if (result.profile.role === 'admin') return result;
  if (scopes.some((s) => result.profile.scopes.includes(s))) return result;
  return {
    ok: false,
    response: NextResponse.json({ error: 'Missing required scope', required: scopes }, { status: 403 }),
  };
}

export async function requireAdmin(): Promise<Guard> {
  const result = await loadProfile();
  if (!result.ok) return result;
  if (result.profile.role !== 'admin') {
    return { ok: false, response: NextResponse.json({ error: 'Admin only' }, { status: 403 }) };
  }
  return result;
}

/**
 * Just require an active session — no scope check. Use for endpoints
 * that any active user is allowed to hit (e.g. reading own profile).
 */
export async function requireActive(): Promise<Guard> {
  return loadProfile();
}
