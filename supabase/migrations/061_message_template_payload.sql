-- ============================================================
-- 061_message_template_payload
--
-- A sent template is more than its body. The header image, the footer
-- and the buttons — including the URL each button opens, whose {{1}}
-- suffix is filled per send (a cart link, an order page) — reach the
-- customer's phone, but `messages` kept only the substituted body in
-- `content_text`. The Inbox showed a bare paragraph ending "tap the
-- button below" with no button, and an agent could not see what link
-- the customer was given.
--
-- `messages.template_payload` stores what was rendered for that send:
--
--   {
--     "header":  { "format": "image", "link": "https://…" }   -- or
--                { "format": "text",  "text": "Order shipped" },
--     "footer":  "www.vanamati.com",
--     "buttons": [ { "type": "URL", "text": "Complete your order",
--                    "url": "https://vanamati.com/cart?…" }, … ]
--   }
--
-- Only set on outbound `content_type = 'template'` rows; NULL for every
-- row written before this migration (no backfill: the per-send values
-- were never stored). The send path tolerates this column being absent,
-- so the migration can be applied before or after deploying the code.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS template_payload JSONB;

COMMENT ON COLUMN messages.template_payload IS
  'Rendered header / footer / buttons (with final button URLs) of an outbound '
  'template message, so the Inbox can show what the customer received. '
  'NULL for non-template rows and rows sent before migration 061.';
