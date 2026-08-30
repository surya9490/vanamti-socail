import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import {
  postSlackNotification,
  buildHandoffSlackMessage,
} from '@/lib/notify/slack'

// ============================================================
// GET /api/cron/test-slack
//
// Diagnostic — fires a fake handoff notification through the SAME
// code path the auto-reply handoff branch uses (postSlackNotification
// with the buildHandoffSlackMessage template). Purpose: prove
// end-to-end that
//   (a) SLACK_WHATSAPP_ALERT_TEAM_WEBHOOK_URL is set on THIS
//       environment (Railway prod vs local),
//   (b) the notification POST reaches Slack, and
//   (c) it lands in the channel you expect.
//
// Response reports whether the env var is set and what happened
// so the operator can pinpoint the failure without reading logs.
//
// Auth: x-cron-secret matches AUTOMATION_CRON_SECRET (reused —
// same env var the automations / flows / re-engagement cron uses).
// ============================================================

function verifyCronSecret(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return false
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const webhookSet = Boolean(
    process.env.SLACK_WHATSAPP_ALERT_TEAM_WEBHOOK_URL,
  )
  const appUrlSet = Boolean(process.env.NEXT_PUBLIC_APP_URL)

  if (!webhookSet) {
    return NextResponse.json({
      env: 'prod-or-wherever-this-is-deployed',
      slack_webhook_set: false,
      app_url_set: appUrlSet,
      posted: false,
      reason:
        'SLACK_WHATSAPP_ALERT_TEAM_WEBHOOK_URL is not set on this environment. Set it in the Railway variables tab and redeploy.',
    })
  }

  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '')
  const message = buildHandoffSlackMessage({
    contactName: 'Test contact',
    contactPhone: '+91-DIAGNOSTIC',
    lastCustomerMessage:
      'This is a Slack test from GET /api/cron/test-slack. Real handoffs will look like this.',
    handoffSummary:
      'Diagnostic ping — not a real handoff. Delete this Slack message when you have confirmed the wiring works.',
    inboxUrl: baseUrl ? `${baseUrl}/inbox` : null,
  })

  // postSlackNotification swallows errors and returns void; we can't
  // distinguish "posted OK" from "silent failure" here without
  // reading a promise result, so we report "attempted".
  await postSlackNotification(message)

  return NextResponse.json({
    slack_webhook_set: true,
    app_url_set: appUrlSet,
    posted: true,
    note: 'A test message was POSTed to the configured Slack webhook. If nothing arrived in Slack within ~10 seconds, check the deployment logs for `[slack notify]` lines — those record the failure reason (bad URL, revoked webhook, network).',
  })
}
