import type { AiTool } from './registry'
import { engineSendProductList } from '@/lib/flows/meta-send'
import { buildProductCatalogRetailerIds } from '@/lib/products/catalog-sections'

// ============================================================
// send_product_catalog tool — sends a native WhatsApp Multi-Product
// Message (Commerce catalog) with product images, prices, and a
// "View" button per card. Renders as a scrollable list of product
// cards inside WhatsApp — much richer than a text list, and FREE
// within the customer's 24hr session window.
//
// When to call (prompt tells the model):
//   * Customer's opener is generic ("hi", "hello", "what do you
//     sell", "show me products") AND
//   * We're inside the 24hr session window (the customer just
//     messaged us — this is always true at auto-reply time).
//
// Setup required on the operator side:
//   * Meta Business Verified ✓ (Vanamati already is)
//   * WhatsApp Business Commerce catalog created in Meta Business
//     Manager, ID set as env WHATSAPP_CATALOG_ID
//   * Products synced to the catalog (via Meta's Shopify sync app
//     OR manually). The product_retailer_id per catalog item
//     needs to match the shop_product_id we pass — for Vanamati's
//     Shopify → Meta sync, retailer_id defaults to the Shopify
//     product id (numeric).
//
// If env is missing OR the catalog isn't set up, the tool returns
// UNAVAILABLE and the model falls back to the text-list greeting.
// ============================================================

const UNAVAILABLE =
  'The visual product catalogue is not configured yet. Fall back to listing products as text using product_lookup.'

const MISSING_PRODUCTS =
  'No active products in the cache to send. Ask the customer what they are looking for as a text reply.'

const MAX_PRODUCTS = 8 // Meta cap is 30; keep the message short for WhatsApp.

function catalogConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_CATALOG_ID)
}

export const sendProductCatalogTool: AiTool = {
  name: 'send_product_catalog',
  label: 'Send product catalogue (WhatsApp catalog)',
  description:
    'Send the customer a native WhatsApp multi-product message with images, prices, and a "View" button per product. ' +
    'Use this ONLY on a generic opener (hi / hello / namaste / "show me products" / "what do you sell") when a visual catalog is more helpful than text. ' +
    'Do NOT use on follow-up messages, on specific product questions ("do you have honey"), or during a close flow — those need a targeted text response. ' +
    'After calling this tool, DO NOT send a text list of the same products in your reply — the catalog IS the reply. Just add a short warm line ("Namaste! Tap any product to see details 🌿"). ' +
    'Returns a status string; on success the message is already sent to the customer.',
  parameters: {
    type: 'OBJECT',
    properties: {
      body_text: {
        type: 'STRING',
        description:
          'Short body text shown ABOVE the product cards (max 1024 chars, typically <100). E.g. "Here\'s what we have at Vanamati — tap any product to see details 🌿".',
      },
      header_text: {
        type: 'STRING',
        description:
          'Optional short header text shown at the top of the message. E.g. "Our products". Omit to skip.',
      },
    },
    required: ['body_text'],
  },
  async run(args, ctx) {
    if (!catalogConfigured()) return UNAVAILABLE

    const bodyText =
      typeof args.body_text === 'string' && args.body_text.trim()
        ? args.body_text.trim()
        : "Here's what we have — tap any product to see details 🌿"
    const headerText =
      typeof args.header_text === 'string' && args.header_text.trim()
        ? args.header_text.trim()
        : undefined

    // Shared helper: same list the re-engagement cron sends when
    // running a stage of type='catalog'.
    const productRetailerIds = await buildProductCatalogRetailerIds(
      ctx.db,
      ctx.accountId,
      MAX_PRODUCTS,
    )
    if (productRetailerIds.length === 0) return MISSING_PRODUCTS

    console.log(
      `[send_product_catalog] sending ${productRetailerIds.length} products; retailer_ids=${JSON.stringify(productRetailerIds)}`,
    )
    try {
      await engineSendProductList({
        accountId: ctx.accountId,
        userId: '', // audit column; blank is fine for AI-initiated sends
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        catalogId: process.env.WHATSAPP_CATALOG_ID!,
        bodyText,
        headerText,
        sections: [
          {
            title: 'Featured',
            productRetailerIds,
          },
        ],
      })
      return `Product catalogue sent to the customer with ${productRetailerIds.length} products. Do NOT list the same products again in your reply — the catalog IS the reply. A short acknowledgement is enough.`
    } catch (err) {
      console.warn(
        '[send_product_catalog] Meta send failed:',
        err instanceof Error ? err.message : err,
      )
      return UNAVAILABLE
    }
  },
}
