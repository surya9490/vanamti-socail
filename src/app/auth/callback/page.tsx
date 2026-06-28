"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * /auth/callback — landing page for every Supabase email link
 * (password recovery, magic link, email confirmation).
 *
 * Why this is a client page (not a server route handler):
 *   Supabase Auth has two emission modes. PKCE puts the auth code
 *   in the URL query as `?code=…` (server can read it). Implicit
 *   puts the tokens in the URL hash as `#access_token=…&type=…`
 *   (server CANNOT read fragments — they're never sent in the
 *   HTTP request). The admin API's `generateLink({type:'recovery'})`
 *   uses implicit flow, and so do magic links by default. A
 *   server-only handler silently broke recovery for that reason —
 *   it saw no `?code` and bounced everyone to /login. A client
 *   component can read both shapes, so it handles either flow.
 *
 * The @supabase/ssr browser client auto-parses the hash on init
 * and persists the session into cookies (so middleware on the next
 * navigation sees the user as authenticated). We just wait for
 * getSession() to settle, then route to `next`.
 */
// useSearchParams() forces client-side rendering, which means
// Next.js 16's static-generation pass needs a <Suspense> boundary
// around any component that calls it. Without one, `next build`
// fails with "missing-suspense-with-csr-bailout". Splitting the
// page into a thin Suspense shell + inner component is the
// recommended pattern.
export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<CallbackChrome message="Loading…" />}>
      <AuthCallbackInner />
    </Suspense>
  );
}

function CallbackChrome({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="flex items-center gap-3 text-slate-300">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        {message}
      </div>
    </div>
  );
}

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const supabase = createClient();
      const code = searchParams.get("code");
      const tokenHash = searchParams.get("token_hash");
      const type = searchParams.get("type"); // 'recovery' | 'signup' | 'magiclink' | …
      const nextParam = searchParams.get("next") ?? "/dashboard";
      // Same-origin relative paths only — `next` is user-controlled
      // (via the email link); don't let it forward to an external
      // site after the user has just authenticated.
      const next =
        nextParam.startsWith("/") && !nextParam.startsWith("//")
          ? nextParam
          : "/dashboard";

      // token_hash branch: admin-generated links (and our own email
      // confirm flow built around supabase.auth.admin.generateLink)
      // arrive here directly with `?token_hash=…&type=…`, skipping
      // Supabase's /auth/v1/verify endpoint. verifyOtp consumes the
      // hash and establishes the session — no PKCE verifier in
      // storage required (which is the failure mode of going through
      // /auth/v1/verify for admin-issued links).
      if (tokenHash && type) {
        const { error: vErr } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          // Cast: searchParams.get returns string; the SDK has its
          // own type literal but accepts these strings at runtime.
          type: type as "recovery" | "magiclink" | "signup" | "invite" | "email_change" | "email",
        });
        if (cancelled) return;
        if (vErr) {
          setError(vErr.message);
          return;
        }
        router.replace(next);
        return;
      }

      // PKCE branch: `?code` present → exchange for a session. Used
      // by browser-initiated flows (OAuth, signInWithOtp from this
      // app) where the verifier was stored in cookies by @supabase/ssr.
      if (code) {
        const { error: exErr } = await supabase.auth.exchangeCodeForSession(code);
        if (cancelled) return;
        if (exErr) {
          setError(exErr.message);
          return;
        }
        router.replace(next);
        return;
      }

      // Implicit branch: tokens in the URL hash. The browser client
      // parses `#access_token=…` on instantiation and stashes the
      // session; getSession() returns it once parsing settles.
      const { data, error: sErr } = await supabase.auth.getSession();
      if (cancelled) return;
      if (sErr) {
        setError(sErr.message);
        return;
      }
      if (!data.session) {
        setError("No session found in the callback URL.");
        return;
      }
      router.replace(next);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="text-center">
        {error ? (
          <>
            <p className="text-sm text-red-400">Sign-in failed: {error}</p>
            <a
              href="/login"
              className="mt-4 inline-block text-sm text-slate-300 underline"
            >
              Back to sign in
            </a>
          </>
        ) : (
          <div className="flex items-center gap-3 text-slate-300">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Signing you in…
          </div>
        )}
      </div>
    </div>
  );
}
