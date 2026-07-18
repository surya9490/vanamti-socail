/**
 * Starter flow templates.
 *
 * A set of pre-canned flows users can clone with one click instead of
 * building from scratch. Each template is a plain JS object describing
 * the same shape `/api/flows` PUT accepts — name, trigger config,
 * entry_node_id, fallback_policy, nodes[] — keyed by a stable
 * `slug`.
 *
 * The clone path (`/api/flows` POST with `template_slug`) creates a
 * NEW flow_row + flow_nodes rows for the user. `node_key`s are kept
 * verbatim (they're stable strings, not UUIDs, so cloning never
 * needs to rewrite edge references).
 *
 * Choosing a single static module over a DB-backed gallery for v1
 * because: (a) the set is small and changes with code releases, not
 * data; (b) keeps templates portable across self-hosted instances
 * without migrations; (c) editing in source is the lowest-friction
 * way to add the next template.
 */

import type {
  AwaitImageNodeConfig,
  CollectInputNodeConfig,
  ConditionNodeConfig,
  HandoffNodeConfig,
  KeywordTriggerConfig,
  OrderLookupNodeConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMediaNodeConfig,
  SendMessageNodeConfig,
  StartNodeConfig,
} from "./types";

export type FlowTemplateNodeType =
  | "start"
  | "send_message"
  | "send_buttons"
  | "send_list"
  | "send_media"
  | "collect_input"
  | "await_image"
  | "condition"
  | "set_tag"
  | "order_lookup"
  | "handoff"
  | "end";

export interface FlowTemplateNode {
  node_key: string;
  node_type: FlowTemplateNodeType;
  config:
    | StartNodeConfig
    | SendMessageNodeConfig
    | SendButtonsNodeConfig
    | SendListNodeConfig
    | SendMediaNodeConfig
    | CollectInputNodeConfig
    | AwaitImageNodeConfig
    | ConditionNodeConfig
    | OrderLookupNodeConfig
    | HandoffNodeConfig
    | Record<string, unknown>;
}

export interface FlowTemplate {
  slug: string;
  name: string;
  description: string;
  /** Used by the gallery to surface a relevant icon. lucide-react name. */
  icon: "MessageSquare" | "HelpCircle" | "UserPlus";
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: KeywordTriggerConfig | Record<string, unknown>;
  entry_node_id: string;
  nodes: FlowTemplateNode[];
}

// ============================================================
// 1. Welcome menu — the example from the owner's brief
// ============================================================
const WELCOME_MENU: FlowTemplate = {
  slug: "welcome_menu",
  name: "Welcome menu",
  description:
    "Greet customers who type a keyword and route them to the right agent based on whether they're new or existing.",
  icon: "MessageSquare",
  trigger_type: "keyword",
  trigger_config: { keywords: ["support", "help", "hi"], match_type: "contains" },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "welcome" },
    },
    {
      node_key: "welcome",
      node_type: "send_buttons",
      config: {
        text: "Hi! 👋 Welcome to support. Are you an existing customer or new here?",
        footer_text: "Tap a button below to continue.",
        buttons: [
          {
            reply_id: "existing",
            title: "Existing customer",
            next_node_key: "existing_handoff",
          },
          {
            reply_id: "new",
            title: "New customer",
            next_node_key: "new_handoff",
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "existing_handoff",
      node_type: "handoff",
      config: {
        note: "Existing customer needs assistance — please check account history before replying.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "new_handoff",
      node_type: "handoff",
      config: {
        note: "New customer — share pricing + onboarding link.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 2. FAQ bot — list-message answers, fully automated
// ============================================================
const FAQ_BOT: FlowTemplate = {
  slug: "faq_bot",
  name: "FAQ bot",
  description:
    "Answer common questions automatically. Customer picks a topic from a list; the bot replies with the answer and ends.",
  icon: "HelpCircle",
  trigger_type: "keyword",
  trigger_config: {
    keywords: ["faq", "question", "info"],
    match_type: "contains",
  },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "topics" },
    },
    {
      node_key: "topics",
      node_type: "send_list",
      config: {
        text: "What can I help you with?",
        button_label: "View topics",
        sections: [
          {
            title: "Common questions",
            rows: [
              {
                reply_id: "hours",
                title: "Opening hours",
                next_node_key: "answer_hours",
              },
              {
                reply_id: "pricing",
                title: "Pricing",
                next_node_key: "answer_pricing",
              },
              {
                reply_id: "refunds",
                title: "Refund policy",
                next_node_key: "answer_refunds",
              },
            ],
          },
          {
            title: "Other",
            rows: [
              {
                reply_id: "human",
                title: "Talk to a human",
                next_node_key: "human_handoff",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    {
      node_key: "answer_hours",
      node_type: "send_message",
      config: {
        text: "We're open Mon–Fri, 9am–6pm local time. Weekend support is limited to urgent issues.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_pricing",
      node_type: "send_message",
      config: {
        text: "Our pricing starts at $9/mo. Visit https://example.com/pricing for the full breakdown.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_refunds",
      node_type: "send_message",
      config: {
        text: "Refunds are honored within 30 days of purchase. Reply with your order number and we'll process it.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "human_handoff",
      node_type: "handoff",
      config: {
        note: "Customer asked to talk to a human from the FAQ bot.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "end",
      node_type: "end",
      config: {},
    },
  ],
};

// ============================================================
// 3. Lead capture — collect_input chain, ends in a handoff
// ============================================================
const LEAD_CAPTURE: FlowTemplate = {
  slug: "lead_capture",
  name: "Lead capture",
  description:
    "Greet first-time inbounds, capture name + email + company, then hand off to sales with the answers in the note.",
  icon: "UserPlus",
  trigger_type: "first_inbound_message",
  trigger_config: {},
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "intro" },
    },
    {
      node_key: "intro",
      node_type: "send_message",
      config: {
        text: "Welcome! 👋 I'll ask a few quick questions so we can get you to the right person.",
        next_node_key: "ask_name",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "ask_name",
      node_type: "collect_input",
      config: {
        prompt_text: "What's your name?",
        var_key: "name",
        next_node_key: "ask_email",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_email",
      node_type: "collect_input",
      config: {
        prompt_text: "Thanks {{vars.name}}! What's your work email?",
        var_key: "email",
        next_node_key: "ask_company",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_company",
      node_type: "collect_input",
      config: {
        prompt_text: "Almost done — what's your company name?",
        var_key: "company",
        next_node_key: "handoff",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "handoff",
      node_type: "handoff",
      config: {
        note: "New lead — name={{vars.name}}, email={{vars.email}}, company={{vars.company}}.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 4. Vanamati — full shop & order flow
//
// Menu (Honey / Ghee / Help) → product list with live prices →
// collect address → send payment QR → capture payment screenshot →
// thank-you → hand off to the team to verify & dispatch. Plus an
// order-tracking command and an FAQ branch.
//
// Prices are a snapshot from the Vanamati Shopify store (Forest,
// Acacia, Multifloral honey + A2 Bilona ghee); update the list rows
// here if store prices change. The QR step ships with an empty media
// URL — upload your UPI/payment QR to it in the builder before
// activating (validation will flag it until you do).
//
// Trigger: keyword "starts with" — fires on greetings (hi/hello/…) AND
// command words (menu/order/shop/honey/ghee/track), so customers can
// either say hi or type a command to open the shop.
// ============================================================
const VANAMATI_STORE: FlowTemplate = {
  slug: "vanamati_store",
  name: "Vanamati — shop & order",
  description:
    "The full storefront: greet on hi/menu/order, show the honey & ghee menu with prices, take the delivery address, send your payment QR, capture the payment screenshot, thank the customer, and hand the order to your team to verify & dispatch. Includes order tracking + FAQs. Upload your payment QR to the 'Send media' step before activating.",
  icon: "MessageSquare",
  trigger_type: "keyword",
  trigger_config: {
    keywords: [
      "hi",
      "hello",
      "hey",
      "namaste",
      "hola",
      "menu",
      "order",
      "buy",
      "shop",
      "honey",
      "ghee",
      "price",
      "prices",
      "catalog",
    ],
    match_type: "starts_with",
  },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "category_menu" },
    },
    // ---- Main menu: Honey / Ghee / Help ----
    {
      node_key: "category_menu",
      node_type: "send_buttons",
      config: {
        text:
          "🙏 Welcome to Vanamati!\n\nPure, raw honey & A2 Bilona ghee — straight from the farm, no additives. What would you like?",
        footer_text: "Tap a category to begin.",
        buttons: [
          { reply_id: "cat_honey", title: "🍯 Honey", next_node_key: "honey_menu" },
          { reply_id: "cat_ghee", title: "🧈 Ghee", next_node_key: "ghee_menu" },
          {
            reply_id: "cat_help",
            title: "📦 Track / Help",
            next_node_key: "help_menu",
          },
        ],
      } as SendButtonsNodeConfig,
    },
    // ---- Honey list (3 types × 3 sizes = 9 rows, ≤10 limit) ----
    {
      node_key: "honey_menu",
      node_type: "send_list",
      config: {
        text: "Our honey — tap a size to order. All raw, unfiltered & single-origin. 🐝",
        button_label: "View honey",
        footer_text: "Prices in ₹. Pick any to continue.",
        sections: [
          {
            title: "Forest Honey (Coorg)",
            rows: [
              {
                reply_id: "forest_250",
                title: "250ml — ₹549",
                description: "Wild honey from the Coorg forests",
                next_node_key: "collect_address",
              },
              {
                reply_id: "forest_500",
                title: "500ml — ₹999",
                description: "Wild honey from the Coorg forests",
                next_node_key: "collect_address",
              },
              {
                reply_id: "forest_1000",
                title: "1000ml — ₹1799",
                description: "Wild honey from the Coorg forests",
                next_node_key: "collect_address",
              },
            ],
          },
          {
            title: "Acacia Honey",
            rows: [
              {
                reply_id: "acacia_250",
                title: "250ml — ₹349",
                description: "Light, mild & delicately sweet",
                next_node_key: "collect_address",
              },
              {
                reply_id: "acacia_500",
                title: "500ml — ₹699",
                description: "Light, mild & delicately sweet",
                next_node_key: "collect_address",
              },
              {
                reply_id: "acacia_1000",
                title: "1000ml — ₹1299",
                description: "Light, mild & delicately sweet",
                next_node_key: "collect_address",
              },
            ],
          },
          {
            title: "Multifloral Honey",
            rows: [
              {
                reply_id: "multi_250",
                title: "250ml — ₹299",
                description: "Everyday wildflower honey",
                next_node_key: "collect_address",
              },
              {
                reply_id: "multi_500",
                title: "500ml — ₹649",
                description: "Everyday wildflower honey",
                next_node_key: "collect_address",
              },
              {
                reply_id: "multi_1000",
                title: "1000ml — ₹1099",
                description: "Everyday wildflower honey",
                next_node_key: "collect_address",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    // ---- Ghee list ----
    {
      node_key: "ghee_menu",
      node_type: "send_list",
      config: {
        text: "Our A2 Cow Ghee — traditional Bilona method, from indigenous desi cows. 🧈",
        button_label: "View ghee",
        footer_text: "Prices in ₹. Pick a size to order.",
        sections: [
          {
            title: "A2 Cow Ghee (Bilona)",
            rows: [
              {
                reply_id: "ghee_250",
                title: "250ml — ₹599",
                description: "Hand-churned pure desi Bilona ghee",
                next_node_key: "collect_address",
              },
              {
                reply_id: "ghee_500",
                title: "500ml — ₹1099",
                description: "Hand-churned pure desi Bilona ghee",
                next_node_key: "collect_address",
              },
              {
                reply_id: "ghee_1000",
                title: "1000ml — ₹1999",
                description: "Hand-churned pure desi Bilona ghee",
                next_node_key: "collect_address",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    // ---- Checkout: address → QR → payment screenshot → thanks → handoff ----
    {
      node_key: "collect_address",
      node_type: "collect_input",
      config: {
        prompt_text:
          "Great choice! 🎉\n\nPlease reply with your *full delivery address* (with pincode) and your *name* so we can ship your order.",
        var_key: "address",
        next_node_key: "pay_intro",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "pay_intro",
      node_type: "send_message",
      config: {
        text:
          "Thank you! 🙏\n\nTo confirm your order, scan the QR below and pay the amount shown for your item. Works with any UPI app — GPay / PhonePe / Paytm. 👇",
        next_node_key: "qr",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "qr",
      node_type: "send_media",
      config: {
        media_type: "image",
        // ⬆️ Upload your UPI / payment QR image to this step in the
        // builder before activating the flow.
        media_url: "",
        caption: "Scan to pay via any UPI app 👆",
        filename: "",
        next_node_key: "await_payment",
      } as SendMediaNodeConfig,
    },
    {
      node_key: "await_payment",
      node_type: "await_image",
      config: {
        prompt_text:
          "Once you've paid, please send a *screenshot of the payment* here so we can confirm it. 📸",
        var_key: "payment_proof",
        next_node_key: "order_thanks",
      } as AwaitImageNodeConfig,
    },
    {
      node_key: "order_thanks",
      node_type: "send_message",
      config: {
        text:
          "🙏 Thank you for your order and for choosing Vanamati!\n\nWe've received your payment screenshot. Our team will *verify the payment* and *dispatch your order shortly* — you'll get all the updates right here. 🍯",
        next_node_key: "order_handoff",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "order_handoff",
      node_type: "handoff",
      config: {
        note: "💰 NEW ORDER — verify payment & dispatch. The customer's product choice, delivery address, and payment screenshot are all in this conversation above (address + screenshot captured to the order).",
      } as HandoffNodeConfig,
    },
    // ---- Help menu: Track order / FAQs / Human ----
    {
      node_key: "help_menu",
      node_type: "send_buttons",
      config: {
        text: "How can we help?",
        buttons: [
          { reply_id: "track", title: "📦 Track order", next_node_key: "track_order" },
          { reply_id: "faqs", title: "❓ FAQs", next_node_key: "faq_menu" },
          {
            reply_id: "human",
            title: "💬 Talk to human",
            next_node_key: "human_handoff",
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "track_order",
      node_type: "collect_input",
      config: {
        prompt_text:
          "Sure! Please send your *order number* (from your confirmation), e.g. 1024.",
        var_key: "order_number",
        next_node_key: "do_lookup",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "do_lookup",
      node_type: "order_lookup",
      config: {
        order_var: "order_number",
        next_node_key: "after_answer",
      } as OrderLookupNodeConfig,
    },
    // ---- FAQ branch ----
    {
      node_key: "faq_menu",
      node_type: "send_list",
      config: {
        text: "Pick a question:",
        button_label: "See questions",
        sections: [
          {
            title: "Questions",
            rows: [
              {
                reply_id: "faq_purity",
                title: "Are your products pure?",
                description: "Lab-tested, no additives",
                next_node_key: "faq_purity_ans",
              },
              {
                reply_id: "faq_shipping",
                title: "Do you ship pan-India?",
                description: "Dispatch & delivery timelines",
                next_node_key: "faq_shipping_ans",
              },
              {
                reply_id: "faq_shelf",
                title: "How long do they last?",
                description: "Honey & ghee shelf life",
                next_node_key: "faq_shelf_ans",
              },
              {
                reply_id: "faq_pay",
                title: "Payment & COD?",
                description: "How to pay for your order",
                next_node_key: "faq_pay_ans",
              },
              {
                reply_id: "faq_human",
                title: "Talk to a human",
                description: "Chat with our team",
                next_node_key: "human_handoff",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    {
      node_key: "faq_purity_ans",
      node_type: "send_message",
      config: {
        text:
          "✅ Every batch is lab-tested for purity and traceable to the farm. No sugar, syrup, or additives — ever. Raw, unpasteurised and single-origin.",
        next_node_key: "after_answer",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "faq_shipping_ans",
      node_type: "send_message",
      config: {
        text:
          "🚚 We ship across India. Orders placed before 4pm dispatch the same day (Mon–Sat). Delivery in 3–7 business days depending on your PIN code.",
        next_node_key: "after_answer",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "faq_shelf_ans",
      node_type: "send_message",
      config: {
        text:
          "🧴 Raw honey stays good for 24 months in a cool, dry place — natural crystallisation is normal & safe. A2 ghee stays fresh 6 months at room temperature; refrigerate to extend.",
        next_node_key: "after_answer",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "faq_pay_ans",
      node_type: "send_message",
      config: {
        text:
          "💳 Pay by UPI (GPay / PhonePe / Paytm) via the QR we share when you order. Cash on Delivery is available on orders above ₹500.",
        next_node_key: "after_answer",
      } as SendMessageNodeConfig,
    },
    // ---- Post-answer navigation ----
    {
      node_key: "after_answer",
      node_type: "send_buttons",
      config: {
        text: "Anything else?",
        buttons: [
          {
            reply_id: "back_menu",
            title: "🛍️ See products",
            next_node_key: "category_menu",
          },
          {
            reply_id: "more_faq",
            title: "❓ More questions",
            next_node_key: "faq_menu",
          },
          { reply_id: "done", title: "✅ That's all", next_node_key: "end" },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "human_handoff",
      node_type: "handoff",
      config: {
        note: "Customer asked to talk to a human from the Vanamati menu.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "end",
      node_type: "end",
      config: {},
    },
  ],
};

// ============================================================
// Registry
// ============================================================

const TEMPLATES: Record<string, FlowTemplate> = {
  welcome_menu: WELCOME_MENU,
  faq_bot: FAQ_BOT,
  lead_capture: LEAD_CAPTURE,
  vanamati_store: VANAMATI_STORE,
};

export function getFlowTemplate(slug: string): FlowTemplate | null {
  return TEMPLATES[slug] ?? null;
}

export function listFlowTemplates(): FlowTemplate[] {
  return Object.values(TEMPLATES);
}
