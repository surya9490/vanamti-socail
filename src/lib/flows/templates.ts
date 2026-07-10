/**
 * Starter flow templates.
 *
 * Three pre-canned flows users can clone with one click instead of
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
  CollectInputNodeConfig,
  ConditionNodeConfig,
  HandoffNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
  StartNodeConfig,
} from "./types";

export type FlowTemplateNodeType =
  | "start"
  | "send_message"
  | "send_buttons"
  | "send_list"
  | "collect_input"
  | "condition"
  | "set_tag"
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
    | CollectInputNodeConfig
    | ConditionNodeConfig
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
// 4. Vanamati — welcome new customer, show product menu, capture interest
// ============================================================
const VANAMATI_STORE: FlowTemplate = {
  slug: "vanamati_store",
  name: "Vanamati — product menu",
  description:
    "Greet every first-time customer with the Vanamati product menu (honey + ghee variants) and an FAQ shortcut. Tapping a product logs interest and hands off to a human for order confirmation.",
  icon: "MessageSquare",
  trigger_type: "first_inbound_message",
  trigger_config: {},
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "welcome" },
    },
    {
      node_key: "welcome",
      node_type: "send_message",
      config: {
        text:
          "🙏 Welcome to Vanamati — pure, natural honey and A2 ghee, sourced straight from small farms with no additives.\n\nHere's what we currently offer:",
        next_node_key: "menu",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "menu",
      node_type: "send_list",
      config: {
        text: "Tap a product to know more or place an order. Our team will reach out to confirm.",
        button_label: "View menu",
        footer_text: "All prices in ₹. Free shipping on orders above ₹999.",
        sections: [
          {
            title: "Honey",
            rows: [
              {
                reply_id: "honey_acacia_1000",
                title: "Acacia Honey 1L",
                description: "₹999 · 1000ml · Mild floral notes",
                next_node_key: "interest_captured",
              },
              {
                reply_id: "honey_acacia_500",
                title: "Acacia Honey 500ml",
                description: "₹599 · 500ml",
                next_node_key: "interest_captured",
              },
              {
                reply_id: "honey_acacia_250",
                title: "Acacia Honey 250ml",
                description: "₹299 · 250ml · Try-me size",
                next_node_key: "interest_captured",
              },
              {
                reply_id: "honey_multi_1000",
                title: "Multi Floral 1L",
                description: "₹899 · 1000ml · Rich wildflower",
                next_node_key: "interest_captured",
              },
              {
                reply_id: "honey_multi_500",
                title: "Multi Floral 500ml",
                description: "₹549 · 500ml",
                next_node_key: "interest_captured",
              },
              {
                reply_id: "honey_multi_250",
                title: "Multi Floral 250ml",
                description: "₹249 · 250ml · Try-me size",
                next_node_key: "interest_captured",
              },
            ],
          },
          {
            title: "Ghee",
            rows: [
              {
                reply_id: "ghee_1000",
                title: "A2 Ghee 1L",
                description: "₹1999 · 1000ml · Hand-churned",
                next_node_key: "interest_captured",
              },
              {
                reply_id: "ghee_500",
                title: "A2 Ghee 500ml",
                description: "₹1099 · 500ml",
                next_node_key: "interest_captured",
              },
              {
                reply_id: "ghee_250",
                title: "A2 Ghee 250ml",
                description: "₹599 · 250ml · Try-me size",
                next_node_key: "interest_captured",
              },
            ],
          },
          {
            title: "Help",
            rows: [
              {
                reply_id: "faq",
                title: "FAQs",
                description: "Answers to common questions",
                next_node_key: "faq_menu",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    {
      node_key: "interest_captured",
      node_type: "send_message",
      config: {
        text:
          "Thank you for showing interest 🙌\n\nOur team will reach out to you shortly to confirm sizes, delivery address, and payment. Meanwhile, feel free to ask any questions right here.",
        next_node_key: "interest_handoff",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "interest_handoff",
      node_type: "handoff",
      config: {
        note: "Product interest from menu — check the last interactive reply for the exact SKU the customer picked.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "faq_menu",
      node_type: "send_list",
      config: {
        text: "Pick a question below.",
        button_label: "See questions",
        sections: [
          {
            title: "Questions",
            rows: [
              {
                reply_id: "faq_purity",
                title: "Are your products pure?",
                description: "Every batch tested & certified",
                next_node_key: "faq_purity_ans",
              },
              {
                reply_id: "faq_shipping",
                title: "Do you ship pan-India?",
                description: "Same-day dispatch on weekdays",
                next_node_key: "faq_shipping_ans",
              },
              {
                reply_id: "faq_shelf",
                title: "How long do they last?",
                description: "Honey 24 mo · Ghee 6 mo",
                next_node_key: "faq_shelf_ans",
              },
              {
                reply_id: "faq_cod",
                title: "Is COD available?",
                description: "Yes, on orders above ₹500",
                next_node_key: "faq_cod_ans",
              },
              {
                reply_id: "faq_human",
                title: "Talk to a human",
                description: "Chat with our team",
                next_node_key: "faq_human_handoff",
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
          "✅ Every batch is lab-tested for purity and traceable back to the farm. No sugar, syrup, or additives — ever. Raw, unpasteurised, and single-origin.",
        next_node_key: "faq_after_answer",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "faq_shipping_ans",
      node_type: "send_message",
      config: {
        text:
          "🚚 We ship across India via COD or prepaid. Orders placed before 4 pm dispatch the same day (Mon–Sat). Delivery in 3–7 business days depending on your PIN code.",
        next_node_key: "faq_after_answer",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "faq_shelf_ans",
      node_type: "send_message",
      config: {
        text:
          "🧴 Raw honey stays good for 24 months if kept in a cool, dry place — natural crystallisation is normal and safe. A2 ghee stays fresh for 6 months at room temperature; refrigerate to extend it further.",
        next_node_key: "faq_after_answer",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "faq_cod_ans",
      node_type: "send_message",
      config: {
        text:
          "💳 Cash on Delivery is available on all orders above ₹500. Prepaid orders (UPI / card / netbanking) get a 5% discount at checkout.",
        next_node_key: "faq_after_answer",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "faq_after_answer",
      node_type: "send_buttons",
      config: {
        text: "Anything else I can help with?",
        buttons: [
          {
            reply_id: "back_to_menu",
            title: "See products",
            next_node_key: "menu",
          },
          {
            reply_id: "more_faqs",
            title: "More questions",
            next_node_key: "faq_menu",
          },
          {
            reply_id: "done",
            title: "That's all",
            next_node_key: "end",
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "faq_human_handoff",
      node_type: "handoff",
      config: {
        note: "Customer asked to talk to a human from the FAQ menu.",
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
