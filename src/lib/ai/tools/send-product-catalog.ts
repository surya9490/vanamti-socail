import type { AiTool } from './registry'
import { engineSendProductList } from '@/lib/flows/meta-send'
import { buildProductCatalog } from '@/lib/products/catalog-sections'

// ============================================================
// send_product_catalog tool — sends a native WhatsApp Multi-Product
// Message (Commerce catalog) with product images, prices, and a
// "View" button per card. Renders as a scrollable list of product
// cards inside WhatsApp — much richer than a text list, and FREE
// within the customer's 24hr session window.
//
// When to call (prompt tells the model): any time the customer
// wants to see or choose between products — the opener, "what do
// you sell", a category ask ("do you have honey"), "what else".
// The catalog is the ONLY way the AI shows more than one product;
// it never types a product list. Sends every active product,
// one section per flagged Shopify collection (see catalog-sections).
//
// Setup required on the operator side:
//   * Meta Business Verified ✓ (Vanamati already is)
//   * WhatsApp Business Commerce catalog created in Meta Business
//     Manager, ID set as env WHATSAPP_CATALOG_ID
//   * Products synced to the catalog (via Meta's Shopify sync app
//     OR manually). The product_retailer_id per catalog item
//     needs to match the variant id we pass — for Vanamati's
//     Shopify → Meta sync, retailer_id is the Shopify variant id.
//
// If env is missing OR the send fails, the tool returns UNAVAILABLE
// and the model asks what the customer wants — still no text list.
// ============================================================

const UNAVAILABLE =
  'The product catalogue could not be sent right now. Do NOT list products as text instead. In one short line, ask what they are looking for (e.g. honey or ghee, which size) and then answer about that one product using product_lookup.'

const MISSING_PRODUCTS =
  'No active products in the cache to send. Do NOT list products as text. Ask the customer what they are looking for in one short line.'

function catalogConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_CATALOG_ID)
}

export const sendProductCatalogTool: AiTool = {
  name: 'send_product_catalog',
  label: 'Send product catalogue (WhatsApp catalog)',
  description:
    'Send the customer a native WhatsApp multi-product message: EVERY active product, grouped by collection (e.g. Pure Natural Honey, Pure Desi Ghee), with images, prices, and a "View" button per product. ' +
    'This is the ONLY way to show the customer more than one product — never type a product list or price list instead. ' +
    'Use it whenever the customer wants to see or choose products, at any point in the conversation: greetings / first message, "what do you sell", "products", "price list", "show me", a category ask ("do you have honey", "ghee?", "which honeys"), "what else do you have", recommendations. ' +
    'Do NOT use it when the customer named ONE specific product (answer that product with product_lookup), during checkout (address / payment), or in an order-support conversation. ' +
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

    // Shared helper: same products the re-engagement cron sends
    // when running a stage of type='catalog'. Returns both the
    // retailer_ids (what Meta needs) AND per-product metadata
    // (title/price/image) for the inbox preview payload.
    // No tighter cap than Meta's 30: the bubble is the same size
    // either way (cards open in a sheet), and a lower cap silently
    // dropped whatever sorted last by title.
    const {
      retailerIds: productRetailerIds,
      sections,
      meta: previewProducts,
    } = await buildProductCatalog(ctx.db, ctx.accountId)
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
        sections,
        previewProducts,
      })
      const categories = sections.map((s) => s.title).join(', ')
      return `Product catalogue sent to the customer with ${productRetailerIds.length} products in ${sections.length} collections (${categories}). Do NOT list the same products again in your reply — the catalog IS the reply. A short acknowledgement is enough.`
    } catch (err) {
      console.warn(
        '[send_product_catalog] Meta send failed:',
        err instanceof Error ? err.message : err,
      )
      return UNAVAILABLE
    }
  },
}
