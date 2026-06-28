import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname

  // Self-signup is disabled (deployment is invite-only). The /signup
  // route no longer exists; redirect any stale link / bookmark to
  // /login so users land somewhere sensible instead of a 404.
  if (path === '/signup') {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Auth pages - redirect to dashboard if already logged in (but only if
  // the user's account is active; pending/disabled users get bounced to
  // the pending-approval screen instead).
  if (user && (
    path === '/login' ||
    path === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  // Protected pages - redirect to login if not authenticated.
  const protectedPaths = [
    '/dashboard', '/inbox', '/contacts', '/pipelines',
    '/broadcasts', '/automations', '/flows', '/settings',
  ]
  const isProtectedPath = protectedPaths.some(p => path.startsWith(p))
  if (!user && isProtectedPath) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Pending / disabled gating. Authed users with status != 'active' are
  // shunted to a "waiting for admin approval" screen. We avoid touching
  // the DB on every static asset hit by only looking up profile.status
  // when the path actually targets the app or its API.
  if (user && (isProtectedPath || path.startsWith('/api/')) && !path.startsWith('/api/whatsapp/webhook') && path !== '/pending-approval') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('status')
      .eq('user_id', user.id)
      .maybeSingle()

    const status = profile?.status

    if (status === 'pending' || status === 'disabled') {
      // Block API access outright for non-active users; the UI gets a
      // redirect to the approval page.
      if (path.startsWith('/api/')) {
        return NextResponse.json(
          { error: status === 'pending' ? 'Account pending approval' : 'Account disabled' },
          { status: 403 },
        )
      }
      const url = request.nextUrl.clone()
      url.pathname = '/pending-approval'
      return NextResponse.redirect(url)
    }
  }

  // If a fully active user hits /pending-approval, send them home.
  if (user && path === '/pending-approval') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('status')
      .eq('user_id', user.id)
      .maybeSingle()
    if (profile?.status === 'active') {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard'
      return NextResponse.redirect(url)
    }
  }

  // API routes that need auth (not webhooks).
  if (!user && path.startsWith('/api/whatsapp/') &&
      !path.includes('/webhook')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
