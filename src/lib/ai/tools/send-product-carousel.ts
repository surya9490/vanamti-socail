import type { AiTool } from './registry'
import { engineSendCarouselTemplate } from '@/lib/flows/meta-send'
import { buildProductCarouselCards } from '@/lib/products/carousel-cards'

// ============================================================
// send_product_carousel tool — sends a Meta MARKETING Carousel
// Template with product cards (image, name, price, Shop Now URL).
//
// Different from send_product_catalog:
//   * Uses a Meta-approved TEMPLATE (WhatsApp Business Manager)
//   * Works OUTSIDE the customer's 24hr session window (that's
//     the reason to use a template — sessions block freeform)
//   * COSTS money per send (MARKETING category, ~₹0.85 in India)
//
// When to use:
//   * Re-engagement of silent customers (paired with the Phase 5
//     re-engagement cron — the cron's default template can be
//     the carousel)
//   * Any inbound OUTSIDE the 24hr window where you want a
//     rich visual response
//
// When NOT to use:
//   * Inside the 24hr session window — send_product_catalog is
//     free and just as visual
//   * On every "hi" — will explode cost fast at scale
//
// Setup required on the operator side (one-time):
//   1. Meta Business Manager → Message Templates → Create
//   2. Template type: Media, then choose "Carousel"
//   3. Category: MARKETING
//   4. Body text: e.g. "Hi {{1}}! Here's what we make at
//      Vanamati 🌿" — {{1}} = customer name variable
//   5. Add 4-10 cards, each with:
//        - Image header (upload a placeholder for approval; sent
//          image can differ)
//        - Body: "{{1}} — from ₹{{2}}"  (product name, price)
//        - URL button: "Shop Now" with URL
//          https://vanamati.com/products/{{1}}  (product slug)
//   6. Submit → wait 1-3 days for Meta approval
//   7. Copy the exact template name → set env
//      WHATSAPP_CAROUSEL_TEMPLATE_NAME
//      WHATSAPP_CAROUSEL_TEMPLATE_LANG (default 'en')
//
// If env vars are missing, the tool returns UNAVAILABLE and the
// model falls back to a text list.
// ============================================================

const UNAVAILABLE =
  'The carousel template is not configured. Fall back to send_product_catalog (in-session) or product_lookup (text list).'

const MISSING_PRODUCTS =
  'No active products with images available. Ask the customer what they are looking for as a text reply.'

const MAX_CARDS = 10 // Meta cap

function carouselConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_CAROUSEL_TEMPLATE_NAME)
}

export const sendProductCarouselTool: AiTool = {
  name: 'send_product_carousel',
  label: 'Send product carousel (Marketing template)',
  description:
    "Send a paid MARKETING carousel template with product cards (image, name, price, Shop Now button) — the only way to send a rich visual message OUTSIDE the customer's 24hr session window. " +
    'Each send costs money at Meta MARKETING rates (~₹0.85 in India). Do NOT use inside the 24h session window — prefer send_product_catalog there (free). ' +
    'Use this for re-engagement, or when the customer has been silent for hours and comes back with a generic opener. ' +
    'Returns a status string; on success the message is already sent to the customer.',
  parameters: {
    type: 'OBJECT',
    properties: {
      customer_first_name: {
        type: 'STRING',
        description:
          "Customer's first name to fill the template body {{1}}. Optional — pass \"there\" or leave omitted if unknown.",
      },
    },
    required: [],
  },
  async run(args, ctx) {
    if (!carouselConfigured()) return UNAVAILABLE

    const templateName = process.env.WHATSAPP_CAROUSEL_TEMPLATE_NAME!
    const language = process.env.WHATSAPP_CAROUSEL_TEMPLATE_LANG || 'en'
    const firstName =
      typeof args.customer_first_name === 'string' &&
      args.customer_first_name.trim()
        ? args.customer_first_name.trim()
        : 'there'

    // Shared helper: same cards will be sent by the re-engagement
    // cron when it fires this template.
    const cards = await buildProductCarouselCards(ctx.db, ctx.accountId, MAX_CARDS)
    if (cards.length < 2) return MISSING_PRODUCTS

    try {
      await engineSendCarouselTemplate({
        accountId: ctx.accountId,
        userId: '',
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        templateName,
        language,
        bodyParams: [firstName],
        cards,
        summaryText: `Product carousel: ${cards.length} products`,
      })
      return `Product carousel sent to the customer (${cards.length} cards). Do NOT list the same products in your reply — the carousel IS the reply. A single short warm line is enough.`
    } catch (err) {
      console.warn(
        '[send_product_carousel] Meta send failed:',
        err instanceof Error ? err.message : err,
      )
      return UNAVAILABLE
    }
  },
}
