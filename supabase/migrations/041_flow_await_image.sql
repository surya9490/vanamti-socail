-- ============================================================
-- 041_flow_await_image.sql
--
-- Adds the 'await_image' node type to conversational flows — a
-- suspending node that waits for the customer to send an IMAGE (e.g. a
-- payment screenshot), captures its media URL into flow_runs.vars, and
-- advances. The image twin of 'collect_input'.
--
-- Its config lives in JSONB and is shape-checked by the validator + TS
-- types, not the DB — same drop-and-recreate CHECK pattern migrations
-- 010 / 016 / 028 used.
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
    'await_image',
    'condition',
    'set_tag',
    'order_lookup',
    'handoff',
    'http_fetch',
    'end'
  ));
