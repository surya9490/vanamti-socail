import { AiError, type AiUsage, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import type { AiTool, ToolContext, ToolParameters } from '../tools/registry'
import {
  addUsage,
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

/** Max model⇄tool round-trips before we force a text answer. Mirrors the
 *  Gemini cap in providers/gemini.ts and bounds token spend on runaway
 *  tool loops. */
const MAX_TOOL_ROUNDS = 4

/** Retry policy for 5xx / timeout / network errors. Anthropic's
 *  Messages API is usually reliable; a single retry with a short
 *  backoff catches transient blips without doubling the customer's
 *  wait on a real outage. 4xx (bad request, auth, over-quota) is
 *  never retried — it'd just fail again and cost another call. */
const RETRY_ATTEMPTS = 2
const RETRY_BACKOFF_MS = 500

// ------------------------------------------------------------
// Content blocks — Anthropic's Messages API sends content as an array of
// typed blocks (text | tool_use | tool_result), not a plain string.
// ------------------------------------------------------------

interface AnthropicTextBlock {
  type: 'text'
  text: string
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  stop_reason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): AnthropicMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  const source =
    merged.length > 0
      ? merged
      : [{ role: 'user' as const, content: '(The customer has not sent a message yet.)' }]
  return source.map((m) => ({ role: m.role, content: m.content }))
}

/**
 * Translate an internal `AiTool` (Gemini-shaped: `type:'OBJECT'`,
 * `type:'STRING'`) into Anthropic's `input_schema` (standard JSON Schema:
 * lowercase types, `type:'object'`, `type:'string'`). Kept as a pure
 * transform so the registry stays provider-agnostic.
 */
function toAnthropicInputSchema(params: ToolParameters): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params.properties)) {
    properties[key] = {
      type: value.type.toLowerCase(),
      ...(value.description ? { description: value.description } : {}),
    }
  }
  return {
    type: 'object',
    properties,
    ...(params.required && params.required.length > 0
      ? { required: params.required }
      : {}),
  }
}

/**
 * POST one /v1/messages request. Shared by the plain and tool-calling
 * paths so error handling, timeouts, and version-header stay in one place.
 * Retries once on 5xx or network/timeout errors — 4xx is treated as
 * terminal (retrying wouldn't help and wastes the caller's key spend).
 */
async function postAnthropic(
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<AnthropicResponse> {
  let lastErr: unknown

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    let res: Response
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // Network / abort / timeout. These are the "worth retrying"
      // failure class — provider might be blipping, DNS transient, etc.
      lastErr = toNetworkError(err)
      if (attempt < RETRY_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
        continue
      }
      throw lastErr
    }

    if (!res.ok) {
      // Retry 5xx (server error) but NEVER 4xx (bad key, malformed
      // request, over-quota, rate-limit — those need a code / plan
      // change, not a retry).
      if (res.status >= 500 && attempt < RETRY_ATTEMPTS - 1) {
        lastErr = await providerHttpError('Anthropic', res)
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
        continue
      }
      throw await providerHttpError('Anthropic', res)
    }

    const data = (await res.json().catch(() => null)) as AnthropicResponse | null
    if (!data) {
      throw new AiError('Anthropic returned an unreadable response.', {
        code: 'empty_response',
      })
    }
    return data
  }

  // Loop exit without return happens only if we exhausted retries on
  // errors — throw whatever was captured last.
  throw lastErr ?? new AiError('Anthropic request failed after retries.', {
    code: 'network_error',
  })
}

/**
 * Wrap the system prompt in Anthropic's cache_control block. The
 * system prompt is the same on every reply for a given account
 * (~3K tokens); marking it ephemeral tells Anthropic to cache it
 * for 5 min so subsequent requests only pay ~10% of the input cost
 * on the cached prefix. On a typical sales conversation (5-10 turns
 * within a session) this saves 30-50% of prompt-side spend.
 *
 * Anthropic prompt caching:
 *   - system as an array of blocks with cache_control on the ones
 *     to cache
 *   - eligible prefix must be >=1024 tokens (Sonnet 5) — our system
 *     prompt is ~3K, comfortably over the floor
 *   - separately-billable "cache write" on first call, then "cache
 *     read" (~0.1x cost) on subsequent calls within the 5-min TTL
 */
function cachedSystemBlock(systemPrompt: string): Array<{
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}> {
  return [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
  ]
}

/** Extract joined text from an Anthropic response's content blocks. */
function extractText(data: AnthropicResponse): string {
  return (data.content ?? [])
    .filter((b): b is AnthropicTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}

/** Normalize Anthropic's input/output token counts into our AiUsage. */
function usageFrom(data: AnthropicResponse): AiUsage | null {
  return normalizeUsage({
    prompt: data.usage?.input_tokens,
    completion: data.usage?.output_tokens,
  })
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args
  const data = await postAnthropic(
    apiKey,
    {
      model,
      system: cachedSystemBlock(systemPrompt),
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: normalizeForAnthropic(messages),
    },
    timeoutMs,
  )
  const text = extractText(data)
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  return { text, usage: usageFrom(data) }
}

/**
 * Anthropic with function calling. Runs a bounded model⇄tool loop: offer
 * the model the enabled tools; when it returns `stop_reason: 'tool_use'`,
 * execute each requested tool server-side, feed the results back as
 * `tool_result` blocks, and ask again; stop when the model returns text
 * (or the round cap is hit). Token usage is summed across every round.
 *
 * Mirrors `generateGeminiWithTools` so the two adapters stay
 * behaviourally consistent for `generateReply` to dispatch to.
 */
export async function generateAnthropicWithTools(
  args: ProviderArgs & { tools: AiTool[]; toolContext: ToolContext },
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, toolContext } = args
  // Translate our provider-agnostic tool defs into Anthropic's shape once.
  // `input_schema` is standard JSON Schema (lowercase types), unlike
  // Gemini's `parameters` (uppercase); the tools registry stores the
  // Gemini shape, so this is where the case conversion happens.
  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: toAnthropicInputSchema(t.parameters),
  }))
  // Convo history threaded through every round; append the model's
  // `assistant` turn (echoing its tool_use blocks) plus one `user` turn
  // carrying tool_result blocks after each tool round.
  const conversation: AnthropicMessage[] = normalizeForAnthropic(messages)
  let usage: AiUsage | null = null

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const data = await postAnthropic(
      apiKey,
      {
        model,
        system: cachedSystemBlock(systemPrompt),
        max_tokens: MAX_OUTPUT_TOKENS,
        tools: anthropicTools,
        messages: conversation,
      },
      timeoutMs,
    )
    usage = addUsage(usage, usageFrom(data))

    const content = data.content ?? []
    const toolCalls = content.filter(
      (b): b is AnthropicToolUseBlock => b.type === 'tool_use',
    )

    // stop_reason='tool_use' means: at least one tool_use block is present
    // AND the model is waiting for their results. Any other stop_reason
    // means the model produced its final answer (or hit max_tokens etc.).
    if (data.stop_reason !== 'tool_use' || toolCalls.length === 0) {
      const text = extractText(data)
      if (text) return { text, usage }
      // Rare: end_turn with no text (all blocks were empty). Bail so we
      // don't spin the loop; parseGeneration would drop an empty string.
      break
    }

    // Echo the assistant turn back into the transcript. Must include the
    // FULL content array (text blocks + tool_use blocks together) —
    // Anthropic errors if a tool_use is referenced by a tool_result but
    // the corresponding assistant turn wasn't threaded through.
    conversation.push({ role: 'assistant', content })

    // Run each requested tool server-side. `run` is expected NOT to throw
    // on expected failures (registry-level convention); wrap defensively
    // so an unexpected throw still returns a friendly result to the model
    // instead of aborting the whole reply.
    const results: AnthropicToolResultBlock[] = []
    for (const call of toolCalls) {
      const tool = tools.find((t) => t.name === call.name)
      let result: string
      let isError = false
      try {
        if (!tool) {
          result = `Unknown tool: ${call.name}`
          isError = true
        } else {
          result = await tool.run(call.input ?? {}, toolContext)
        }
      } catch (err) {
        console.error(`[ai tools] "${call.name}" threw:`, err)
        result = 'The tool could not be run right now.'
        isError = true
      }
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: result,
        ...(isError ? { is_error: true } : {}),
      })
    }
    conversation.push({ role: 'user', content: results })
  }

  throw new AiError('Anthropic did not return an answer after tool calls.', {
    code: 'empty_response',
  })
}
