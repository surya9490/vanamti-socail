import type { SupabaseClient } from '@supabase/supabase-js'
import { orderLookupTool } from './order-lookup'
import { productLookupTool } from './product-lookup'
import { createDraftOrderTool } from './create-draft-order'

// ============================================================
// AI tool registry — the allow-list of actions the assistant may take
// mid-conversation via function calling. Only tools listed here can ever
// be exposed to the model; an account further opts in per-tool via
// `ai_configs.enabled_tools`. There is no arbitrary-URL / arbitrary-code
// tool — every tool is a hand-written, reviewed function.
// ============================================================

/** Runtime context handed to a tool's `run` — everything it needs to act
 *  on behalf of THIS conversation, resolved server-side (never from the
 *  model) so a tool can't be tricked into acting for another customer. */
export interface ToolContext {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  /** The contact's stored phone. Null when not on file. Tools that act on
   *  customer-owned data key off this, never a value from the model. */
  contactPhone: string | null
}

/**
 * Function parameters in the shape Gemini's `functionDeclarations` (and
 * OpenAI's `parameters`) expect — a JSON-schema subset with uppercase
 * type names.
 */
export interface ToolParameters {
  type: 'OBJECT'
  properties: Record<string, { type: string; description?: string }>
  required?: string[]
}

export interface AiTool {
  /** Stable identifier — matches what's stored in `enabled_tools` and
   *  what the model calls. */
  name: string
  /** One-line, human-facing label for the settings toggle. */
  label: string
  /** Sent to the model — tells it when to call the tool. */
  description: string
  parameters: ToolParameters
  /**
   * Execute the tool. `args` are the model-supplied arguments (untrusted);
   * `ctx` is the trusted server-side context. Returns a short string that
   * is fed back to the model as the tool result. Should never throw for
   * expected failures — return a friendly message instead.
   */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

const REGISTRY: Record<string, AiTool> = {
  [orderLookupTool.name]: orderLookupTool,
  [productLookupTool.name]: productLookupTool,
  [createDraftOrderTool.name]: createDraftOrderTool,
}

/** Every registered tool — used by the settings UI to render toggles. */
export function allTools(): AiTool[] {
  return Object.values(REGISTRY)
}

/** True when `name` is a real, registered tool (config-route validation). */
export function isKnownTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name)
}

/**
 * Resolve an account's enabled tool names to tool definitions. Unknown
 * names (e.g. a tool removed in a later release) are silently dropped so a
 * stale config never breaks generation.
 */
export function getEnabledTools(
  enabledNames: string[] | null | undefined,
): AiTool[] {
  if (!enabledNames?.length) return []
  return enabledNames
    .map((n) => REGISTRY[n])
    .filter((t): t is AiTool => Boolean(t))
}
