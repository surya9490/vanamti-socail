-- ============================================================
-- 028_flow_order_lookup.sql
--
-- Adds the 'order_lookup' node type to conversational flows — the
-- flow-builder twin of the automations "Order Status Lookup" step
-- (migration 006 stores automation steps as JSONB, so it needed no
-- constraint change; flow_nodes.node_type is a real column with a
-- CHECK, so it does).
--
-- The node calls the Vanamati Shopify app's order-status endpoint
-- (see src/lib/orders/order-tracking.ts) with the contact's phone and
-- replies with the ready-made status text. Its config lives in JSONB
-- and is shape-checked by the validator + TS types, not the DB —
-- same drop-and-recreate CHECK pattern migrations 010 and 016 used.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'order_lookup',
    'handoff',
    'http_fetch',
    'end'
  ));
