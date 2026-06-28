import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { supabaseAdmin } from '@/lib/auth/admin-client';
import { ALL_SCOPES, type Role, type Scope } from '@/types';

const SCOPE_SET = new Set<string>(ALL_SCOPES);

interface InviteBody {
  email?: string;
  role?: Role;
  scopes?: Scope[];
  /** Optional display name pre-filled for the invitee's profile. */
  full_name?: string;
}

/**
 * POST /api/admin/members/invite
 *
 * Admin-only. Invites a new user by email + assigns their role and
 * scopes immediately. The user receives an email (via Supabase's
 * invite template, see supabase/templates/invite.html) with a link
 * to set their initial password and sign in.
 *
 * Flow:
 *   1. requireAdmin guard.
 *   2. Validate inputs (valid role, known scopes, no duplicate email).
 *   3. inviteUserByEmail — Supabase creates the auth.users row, the
 *      DB trigger creates a default profile (member/pending/[]), and
 *      Supabase sends the invite email.
 *   4. Update the just-created profile to the admin's chosen
 *      role/status/scopes. status='active' so the invitee can use
 *      the app immediately after setting their password — no second
 *      approval step.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = (await request.json().catch(() => null)) as InviteBody | null;
  if (!body || !body.email) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }

  const email = body.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'invalid email' }, { status: 400 });
  }

  const role: Role = body.role === 'admin' ? 'admin' : 'member';
  const scopes: Scope[] = Array.isArray(body.scopes) ? body.scopes : [];
  const unknown = scopes.filter((s) => !SCOPE_SET.has(s));
  if (unknown.length > 0) {
    return NextResponse.json({ error: 'unknown scopes', unknown }, { status: 400 });
  }
  // Admins implicitly hold every scope — don't waste space storing
  // an array we'll never read. Matches the PATCH endpoint's behaviour.
  const finalScopes = role === 'admin' ? [] : scopes;

  const admin = supabaseAdmin();

  // Reject duplicate invites up-front with a clean error rather
  // than letting inviteUserByEmail return Supabase's terser variant.
  const { data: existing } = await admin
    .from('profiles')
    .select('id, status')
    .eq('email', email)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: 'A user with that email already exists', existing_status: existing.status },
      { status: 409 },
    );
  }

  // inviteUserByEmail creates the auth.users row + sends the
  // invite email using the template at
  // supabase/templates/invite.html (which we configured to use
  // token_hash so cross-device clicks work). redirectTo controls
  // where the magic link sends the user after Supabase consumes
  // the token — our /auth/callback handles all the verify cases.
  const redirectTo = `${process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '')}/auth/callback?next=/reset-password`;
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: body.full_name ? { full_name: body.full_name } : undefined,
  });
  if (inviteErr || !invited?.user) {
    return NextResponse.json(
      { error: inviteErr?.message ?? 'invite failed' },
      { status: 500 },
    );
  }

  // The on_auth_user_created trigger has now inserted the profile
  // row with default 'member' / 'pending' / []. Promote it to the
  // admin's chosen values so the invitee is immediately active and
  // properly scoped the moment they sign in.
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .update({ role, status: 'active', scopes: finalScopes })
    .eq('user_id', invited.user.id)
    .select('id, user_id, full_name, email, avatar_url, role, status, scopes, created_at')
    .single();
  if (profileErr || !profile) {
    // The auth user was created but we couldn't promote the profile.
    // Roll back the auth user so the admin can retry cleanly rather
    // than ending up with a stuck pending row.
    await admin.auth.admin.deleteUser(invited.user.id);
    return NextResponse.json(
      { error: profileErr?.message ?? 'profile promotion failed' },
      { status: 500 },
    );
  }

  return NextResponse.json({ member: profile }, { status: 201 });
}
