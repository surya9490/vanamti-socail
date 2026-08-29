import crypto from 'node:crypto'

// ============================================================
// HMAC verification for the Vanamati → WACRM product feed.
//
// The Vanamati Shopify app POSTs product events to
// /api/webhooks/vanamati/products with header:
//   x-vanamati-signature: sha256=<hex hmac of the raw body>
//
// Both sides share VANAMATI_WEBHOOK_SECRET — a random string set as
// an env var in each app. Without verification, anyone who guessed
// the URL could push arbitrary products (and prices) into our AI's
// mouth, so this fails closed: no secret set → every request is
// rejected until the operator configures it.
//
// Timing-safe compare via crypto.timingSafeEqual; length mismatch
// short-circuits (timingSafeEqual throws on differing lengths).
// ============================================================

export function verifyVanamatiWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.VANAMATI_WEBHOOK_SECRET
  if (!secret) {
    console.error(
      '[vanamati webhook] VANAMATI_WEBHOOK_SECRET is not set — rejecting request. ' +
        'Configure the env var (same value in both WACRM and the Vanamati Shopify app) ' +
        'to enable signature verification.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
