// ============================================================
// Slack notification helper.
//
// Fire-and-forget POST to a Slack Incoming Webhook. Used today by the
// AI auto-reply handoff branch: when Claude can't (or shouldn't)
// answer and hands the conversation to a human, we notify the team's
// Slack channel so somebody actually picks it up quickly.
//
// Design constraints:
//
//   * MUST NOT block or fail the caller. A dead webhook, a network
//     hiccup, a rate limit, an expired URL — none of these should
//     stop the handoff itself from persisting. All errors are logged
//     and swallowed.
//
//   * Silent no-op when SLACK_TEAM_WEBHOOK_URL is unset. Deployments
//     that don't want Slack notifications just leave the env var
//     empty — no code branches to toggle, no per-account setting to
//     manage. If we grow to N accounts each wanting their own
//     channel, promote to a per-account column on `ai_configs`.
//
//   * Short timeout (3s). Slack's ingress is normally <200ms, so 3s
//     is generous. If we hit the ceiling something is wrong and we'd
//     rather move on than pile up unresolved promises.
//
//   * Content is unstructured markdown-lite (Slack's mrkdwn), NOT
//     Block Kit. Keeps the payload boring and reduces the surface
//     area for the webhook to reject.
// ============================================================

const SLACK_TIMEOUT_MS = 3000

/**
 * POST a plain-text (mrkdwn) message to the configured team Slack
 * webhook. Silent no-op if `SLACK_TEAM_WEBHOOK_URL` isn't set.
 * Always resolves — errors are logged, never thrown.
 */
export async function postSlackNotification(text: string): Promise<void> {
  const webhookUrl = process.env.SLACK_TEAM_WEBHOOK_URL
  if (!webhookUrl) return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS)
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      console.warn(
        `[slack notify] webhook returned ${response.status}: ${body.slice(0, 200)}`,
      )
    }
  } catch (err) {
    console.warn(
      '[slack notify] failed:',
      err instanceof Error ? err.message : err,
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Format a handoff notification the team will see in Slack. The
 * fields are optional to reflect what the caller has on hand — a
 * contact record can be missing a name, an app URL can be unset,
 * etc. Missing pieces just drop out rather than showing 'null'.
 */
export function buildHandoffSlackMessage(args: {
  contactName: string | null
  contactPhone: string | null
  lastCustomerMessage: string | null
  handoffSummary: string
  inboxUrl: string | null
}): string {
  const nameOrPhone =
    args.contactName || args.contactPhone || 'Unknown contact'
  const phoneSuffix =
    args.contactName && args.contactPhone ? ` (${args.contactPhone})` : ''

  const lines: string[] = [
    ':rotating_light: *AI handed off* — please respond',
    `*Contact:* ${nameOrPhone}${phoneSuffix}`,
  ]
  if (args.lastCustomerMessage) {
    lines.push(`*Last message:* ${args.lastCustomerMessage.slice(0, 300)}`)
  }
  lines.push(`*Reason:* ${args.handoffSummary}`)
  if (args.inboxUrl) {
    lines.push(`*Open:* ${args.inboxUrl}`)
  }
  return lines.join('\n')
}
