-- ============================================================
-- 027_contact_opt_out
--
-- Marketing opt-out (STOP/START) state on contacts.
--
-- `opted_out_at IS NOT NULL` means the contact replied STOP (or
-- tapped an opt-out button) and must be excluded from every
-- MARKETING send: broadcasts and marketing template messages via
-- the public API. Utility/transactional messages (order updates,
-- codes the customer asked for) and free-form replies inside the
-- 24h service window are NOT affected — that matches Meta's
-- marketing/utility template categories and customer expectation.
--
-- Set/cleared by the webhook keyword handler
-- (src/lib/contacts/opt-out.ts): STOP → now(), START → NULL.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;

-- Partial index: the send-time exclusion query loads only the
-- opted-out rows of one account. Most contacts never opt out, so a
-- partial index stays tiny.
CREATE INDEX IF NOT EXISTS idx_contacts_opted_out
  ON contacts(account_id)
  WHERE opted_out_at IS NOT NULL;
