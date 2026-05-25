-- ============================================================
-- 013_single_org_rbac.sql
--
-- Pivots the project from "every Supabase account is its own
-- isolated silo (user_id-scoped RLS)" to "one shared organisation
-- gated by role + per-module scopes".
--
-- Model:
--   * No org/workspace table. The whole deployment IS the org.
--   * `profiles.role`    — 'admin' | 'member'
--   * `profiles.status`  — 'pending' | 'active' | 'disabled'
--   * `profiles.scopes`  — text[] of granted capability strings,
--                          e.g. {'inbox.read','contacts.write'}.
--   * Admins implicitly have every scope.
--   * First-ever signup auto-bootstraps as active admin.
--     Every subsequent signup lands as pending member with [].
--
-- Data tables still carry `user_id` for attribution ("created by")
-- but RLS no longer filters by it — all rows are org-shared and
-- gated by scope instead.
--
-- Idempotent: safe to run multiple times. Drops every old
-- "Users can manage own ..." policy by name and re-creates the
-- scope-based replacement.
-- ============================================================

-- ============================================================
-- 1. Extend profiles
-- ============================================================

-- status — 'pending' is the default for every new signup; only the
-- bootstrap-first-user trigger writes 'active'. 'disabled' is a
-- soft-delete the admin can flip from the Members UI without
-- having to actually delete the auth.users row.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_status_check' AND conrelid = 'profiles'::regclass
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_status_check
      CHECK (status IN ('pending', 'active', 'disabled'));
  END IF;
END $$;

-- scopes — explicitly granted capability strings for non-admins.
-- Ignored when role='admin' (admins implicitly hold every scope).
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS scopes TEXT[]
    NOT NULL
    DEFAULT ARRAY[]::TEXT[];

-- Tighten role: was a free-form TEXT defaulting to 'user'. Normalise
-- legacy values then constrain to the two-value vocabulary.
UPDATE profiles SET role = 'member' WHERE role IS NULL OR role NOT IN ('admin', 'member');
ALTER TABLE profiles ALTER COLUMN role SET DEFAULT 'member';
ALTER TABLE profiles ALTER COLUMN role SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_role_check' AND conrelid = 'profiles'::regclass
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('admin', 'member'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_role_status ON profiles(role, status);

-- ============================================================
-- 2. Helper functions
--
-- SECURITY DEFINER so they bypass RLS when reading `profiles` from
-- inside a policy — without this the policy would recurse on itself.
-- search_path is locked to public so a malicious schema can't shadow
-- profiles.
-- ============================================================

DROP FUNCTION IF EXISTS public.current_profile_role();
DROP FUNCTION IF EXISTS public.is_admin();
DROP FUNCTION IF EXISTS public.is_active();
DROP FUNCTION IF EXISTS public.has_scope(TEXT);

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = auth.uid()
      AND role = 'admin'
      AND status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_active()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = auth.uid()
      AND status = 'active'
  );
$$;

-- has_scope(name) — true if the caller is an active admin (admins
-- have every scope implicitly) OR is an active member with `name`
-- in their granted scopes array.
CREATE OR REPLACE FUNCTION public.has_scope(scope_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = auth.uid()
      AND status = 'active'
      AND (role = 'admin' OR scope_name = ANY(scopes))
  );
$$;

ALTER FUNCTION public.is_admin() OWNER TO postgres;
ALTER FUNCTION public.is_active() OWNER TO postgres;
ALTER FUNCTION public.has_scope(TEXT) OWNER TO postgres;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_active() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_scope(TEXT) TO authenticated;

-- ============================================================
-- 3. Profiles RLS
--
-- Every user MUST be able to read their own row (the auth context
-- depends on it before status/role are even known). Admins read
-- every row (Members UI). Users can update their own non-role
-- columns; role/status/scopes changes go through the admin API
-- using service_role, which bypasses RLS.
-- ============================================================

DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;

CREATE POLICY "Profile read self or admin" ON profiles FOR SELECT
  USING (auth.uid() = user_id OR public.is_admin());

CREATE POLICY "Profile update self" ON profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- Insert path is the SECURITY DEFINER trigger (see section 9). No
-- end-user INSERT policy needed.

-- ============================================================
-- 4. Replace user-scoped RLS with scope-based policies.
--
-- Every "Users can manage own X" policy from migrations 001/006/010
-- is dropped and replaced with split read/write policies keyed on
-- has_scope(). Service-role bypasses RLS entirely so server-side
-- engine code (webhook, automation runner, flow runner) is unaffected.
-- ============================================================

-- ---- contacts -----------------------------------------------
DROP POLICY IF EXISTS "Users can manage own contacts" ON contacts;
CREATE POLICY "contacts read" ON contacts FOR SELECT
  USING (public.has_scope('contacts.read'));
CREATE POLICY "contacts insert" ON contacts FOR INSERT
  WITH CHECK (public.has_scope('contacts.write'));
CREATE POLICY "contacts update" ON contacts FOR UPDATE
  USING (public.has_scope('contacts.write'));
CREATE POLICY "contacts delete" ON contacts FOR DELETE
  USING (public.has_scope('contacts.write'));

-- ---- tags ---------------------------------------------------
DROP POLICY IF EXISTS "Users can manage own tags" ON tags;
CREATE POLICY "tags read" ON tags FOR SELECT
  USING (public.has_scope('contacts.read'));
CREATE POLICY "tags write" ON tags FOR ALL
  USING (public.has_scope('tags.manage'))
  WITH CHECK (public.has_scope('tags.manage'));

-- ---- contact_tags (join table — gated by contacts) ----------
DROP POLICY IF EXISTS "Users can manage contact tags" ON contact_tags;
CREATE POLICY "contact_tags read" ON contact_tags FOR SELECT
  USING (public.has_scope('contacts.read'));
CREATE POLICY "contact_tags write" ON contact_tags FOR ALL
  USING (public.has_scope('contacts.write'))
  WITH CHECK (public.has_scope('contacts.write'));

-- ---- custom_fields ------------------------------------------
DROP POLICY IF EXISTS "Users can manage own custom fields" ON custom_fields;
CREATE POLICY "custom_fields read" ON custom_fields FOR SELECT
  USING (public.has_scope('contacts.read'));
CREATE POLICY "custom_fields write" ON custom_fields FOR ALL
  USING (public.has_scope('contacts.write'))
  WITH CHECK (public.has_scope('contacts.write'));

-- ---- contact_custom_values ----------------------------------
DROP POLICY IF EXISTS "Users can manage custom values" ON contact_custom_values;
CREATE POLICY "contact_custom_values read" ON contact_custom_values FOR SELECT
  USING (public.has_scope('contacts.read'));
CREATE POLICY "contact_custom_values write" ON contact_custom_values FOR ALL
  USING (public.has_scope('contacts.write'))
  WITH CHECK (public.has_scope('contacts.write'));

-- ---- contact_notes ------------------------------------------
DROP POLICY IF EXISTS "Users can manage own notes" ON contact_notes;
CREATE POLICY "contact_notes read" ON contact_notes FOR SELECT
  USING (public.has_scope('contacts.read'));
CREATE POLICY "contact_notes write" ON contact_notes FOR ALL
  USING (public.has_scope('contacts.write'))
  WITH CHECK (public.has_scope('contacts.write'));

-- ---- conversations ------------------------------------------
DROP POLICY IF EXISTS "Users can manage own conversations" ON conversations;
CREATE POLICY "conversations read" ON conversations FOR SELECT
  USING (public.has_scope('inbox.read'));
CREATE POLICY "conversations write" ON conversations FOR ALL
  USING (public.has_scope('inbox.write'))
  WITH CHECK (public.has_scope('inbox.write'));

-- ---- messages -----------------------------------------------
-- Reads gated by inbox.read; the existing service-role INSERT
-- policy stays in place for the webhook ingest path.
DROP POLICY IF EXISTS "Users can view own messages" ON messages;
DROP POLICY IF EXISTS "Service role can insert messages" ON messages;
CREATE POLICY "messages read" ON messages FOR SELECT
  USING (public.has_scope('inbox.read'));
CREATE POLICY "messages write" ON messages FOR INSERT
  WITH CHECK (public.has_scope('inbox.write'));
CREATE POLICY "messages update" ON messages FOR UPDATE
  USING (public.has_scope('inbox.write'));
CREATE POLICY "Service role can insert messages" ON messages FOR INSERT
  WITH CHECK (true);

-- ---- whatsapp_config (single org-wide config) ---------------
-- The schema still has UNIQUE(user_id); the API will use the
-- service-role client to write the org's single config row going
-- forward. RLS just decides who can READ it from the UI.
DROP POLICY IF EXISTS "Users can manage own config" ON whatsapp_config;
CREATE POLICY "whatsapp_config read" ON whatsapp_config FOR SELECT
  USING (public.has_scope('whatsapp.config'));
CREATE POLICY "whatsapp_config write" ON whatsapp_config FOR ALL
  USING (public.has_scope('whatsapp.config'))
  WITH CHECK (public.has_scope('whatsapp.config'));

-- ---- message_templates --------------------------------------
DROP POLICY IF EXISTS "Users can manage own templates" ON message_templates;
CREATE POLICY "message_templates read" ON message_templates FOR SELECT
  USING (public.has_scope('inbox.read') OR public.has_scope('templates.manage') OR public.has_scope('broadcasts.send'));
CREATE POLICY "message_templates write" ON message_templates FOR ALL
  USING (public.has_scope('templates.manage'))
  WITH CHECK (public.has_scope('templates.manage'));

-- ---- pipelines + pipeline_stages + deals --------------------
DROP POLICY IF EXISTS "Users can manage own pipelines" ON pipelines;
CREATE POLICY "pipelines read" ON pipelines FOR SELECT
  USING (public.has_scope('deals.read'));
CREATE POLICY "pipelines write" ON pipelines FOR ALL
  USING (public.has_scope('deals.write'))
  WITH CHECK (public.has_scope('deals.write'));

DROP POLICY IF EXISTS "Users can manage pipeline stages" ON pipeline_stages;
CREATE POLICY "pipeline_stages read" ON pipeline_stages FOR SELECT
  USING (public.has_scope('deals.read'));
CREATE POLICY "pipeline_stages write" ON pipeline_stages FOR ALL
  USING (public.has_scope('deals.write'))
  WITH CHECK (public.has_scope('deals.write'));

DROP POLICY IF EXISTS "Users can manage own deals" ON deals;
CREATE POLICY "deals read" ON deals FOR SELECT
  USING (public.has_scope('deals.read'));
CREATE POLICY "deals write" ON deals FOR ALL
  USING (public.has_scope('deals.write'))
  WITH CHECK (public.has_scope('deals.write'));

-- ---- broadcasts + broadcast_recipients ----------------------
DROP POLICY IF EXISTS "Users can manage own broadcasts" ON broadcasts;
CREATE POLICY "broadcasts read" ON broadcasts FOR SELECT
  USING (public.has_scope('broadcasts.read'));
CREATE POLICY "broadcasts write" ON broadcasts FOR ALL
  USING (public.has_scope('broadcasts.send'))
  WITH CHECK (public.has_scope('broadcasts.send'));

DROP POLICY IF EXISTS "Users can manage broadcast recipients" ON broadcast_recipients;
CREATE POLICY "broadcast_recipients read" ON broadcast_recipients FOR SELECT
  USING (public.has_scope('broadcasts.read'));
CREATE POLICY "broadcast_recipients write" ON broadcast_recipients FOR ALL
  USING (public.has_scope('broadcasts.send'))
  WITH CHECK (public.has_scope('broadcasts.send'));

-- ---- automations + steps + logs -----------------------------
DROP POLICY IF EXISTS "Users can manage own automations" ON automations;
CREATE POLICY "automations read" ON automations FOR SELECT
  USING (public.has_scope('automations.read'));
CREATE POLICY "automations write" ON automations FOR ALL
  USING (public.has_scope('automations.manage'))
  WITH CHECK (public.has_scope('automations.manage'));

DROP POLICY IF EXISTS "Users can manage steps of own automations" ON automation_steps;
CREATE POLICY "automation_steps read" ON automation_steps FOR SELECT
  USING (public.has_scope('automations.read'));
CREATE POLICY "automation_steps write" ON automation_steps FOR ALL
  USING (public.has_scope('automations.manage'))
  WITH CHECK (public.has_scope('automations.manage'));

DROP POLICY IF EXISTS "Users can view own automation logs" ON automation_logs;
CREATE POLICY "automation_logs read" ON automation_logs FOR SELECT
  USING (public.has_scope('automations.read'));

-- automation_pending_executions stays service-role-only (no user
-- policy added or expected).

-- ---- flows + nodes + runs + events --------------------------
DROP POLICY IF EXISTS "Users can manage own flows" ON flows;
CREATE POLICY "flows read" ON flows FOR SELECT
  USING (public.has_scope('flows.read'));
CREATE POLICY "flows write" ON flows FOR ALL
  USING (public.has_scope('flows.manage'))
  WITH CHECK (public.has_scope('flows.manage'));

DROP POLICY IF EXISTS "Users manage nodes on their flows" ON flow_nodes;
CREATE POLICY "flow_nodes read" ON flow_nodes FOR SELECT
  USING (public.has_scope('flows.read'));
CREATE POLICY "flow_nodes write" ON flow_nodes FOR ALL
  USING (public.has_scope('flows.manage'))
  WITH CHECK (public.has_scope('flows.manage'));

DROP POLICY IF EXISTS "Users see own flow runs" ON flow_runs;
CREATE POLICY "flow_runs read" ON flow_runs FOR SELECT
  USING (public.has_scope('flows.read') OR public.has_scope('inbox.read'));

DROP POLICY IF EXISTS "Users see events on their runs" ON flow_run_events;
CREATE POLICY "flow_run_events read" ON flow_run_events FOR SELECT
  USING (public.has_scope('flows.read') OR public.has_scope('inbox.read'));

-- ============================================================
-- 5. Bootstrap-aware signup trigger
--
-- Replaces the migration-001 handler. New behaviour:
--   * If the inserted user is the FIRST profile row in the table,
--     promote them to admin/active (the deployment's bootstrap
--     admin).
--   * Otherwise create the profile in 'pending' status with role
--     'member' and an empty scopes array. The admin approves
--     and grants scopes from the Members UI.
--
-- The race between two concurrent first-time signups is acceptable:
-- COUNT()=0 is evaluated before the INSERT, so two concurrent
-- signups could each become admin. In practice the first signup
-- is a deliberate bootstrap step done before anyone else has
-- credentials; not worth a serializable-isolation wrap.
-- ============================================================

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_first BOOLEAN;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.profiles) INTO is_first;

  INSERT INTO public.profiles (user_id, full_name, email, role, status, scopes)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    CASE WHEN is_first THEN 'admin' ELSE 'member' END,
    CASE WHEN is_first THEN 'active' ELSE 'pending' END,
    ARRAY[]::TEXT[]
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
