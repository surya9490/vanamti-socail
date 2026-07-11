import { AiError, type AiUsage, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import type { AiTool, ToolContext } from '../tools/registry'
import {
  addUsage,
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

// Google Gemini (Generative Language API). The model id is part of the
// path, so it's interpolated per call. The account's BYO key goes in the
// `x-goog-api-key` header (cleaner than the `?key=` query param — keeps
// the secret out of URLs/logs).
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

/** Max model⇄tool round-trips before we force a text answer. Bounds token
 *  spend and stops a tool-loop from running away on the account's key. */
const MAX_TOOL_ROUNDS = 4

/**
 * Build the `generationConfig` for a request. Gemini 2.5 *flash* models do
 * an internal "thinking" pass before answering, which is on by default and
 * adds several seconds of latency — unnecessary for short, doc-grounded
 * WhatsApp replies. Setting `thinkingBudget: 0` turns it off (supported by
 * the 2.5 flash tier). Other models don't accept the field, so we only add
 * it when the model name matches, to avoid a 400.
 */
function buildGenConfig(model: string): Record<string, unknown> {
  const cfg: Record<string, unknown> = { maxOutputTokens: MAX_OUTPUT_TOKENS }
  if (/2\.5-flash/i.test(model)) {
    cfg.thinkingConfig = { thinkingBudget: 0 }
  }
  return cfg
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[]; role?: string }
    finishReason?: string
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

interface GeminiErrorBody {
  error?: { message?: string; status?: string }
}

/**
 * Gemini's `contents` use `user` / `model` roles (not `assistant`) and,
 * like Anthropic, want the transcript to start on the customer. Merge
 * consecutive same-role turns, drop any leading assistant turns (an agent
 * greeting before the customer said anything), then map to Gemini's shape.
 * Guarantees a valid, non-empty payload.
 */
function normalizeForGemini(messages: ChatMessage[]): GeminiContent[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  const source =
    merged.length > 0
      ? merged
      : [{ role: 'user' as const, content: '(The customer has not sent a message yet.)' }]
  return source.map((m) => ({
    role: m.role === 'assistant' ? 'model' : ('user' as const),
    parts: [{ text: m.content }],
  }))
}

/** POST one generateContent request; returns the parsed body or throws a
 *  typed AiError. Shared by the plain and tool-calling paths. */
async function postGemini(
  model: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<GeminiResponse> {
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    // Gemini reports a bad key as HTTP 400 `INVALID_ARGUMENT` ("API key
    // not valid"), not 401/403 like OpenAI/Anthropic — so the shared
    // mapper would mislabel it `provider_error`. Detect it here (peeking a
    // clone so `providerHttpError` can still read the body) and surface it
    // as `invalid_key` (401) so the settings "Test key" button is right.
    const peek = (await res.clone().json().catch(() => null)) as GeminiErrorBody | null
    const detail = peek?.error?.message ?? ''
    if (res.status === 400 && /api[_ ]?key not valid|api_key_invalid/i.test(detail)) {
      throw new AiError(
        detail ? `Gemini rejected the API key: ${detail}` : 'Gemini rejected the API key',
        { code: 'invalid_key', status: 401 },
      )
    }
    throw await providerHttpError('Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  if (!data) {
    throw new AiError('Gemini returned an unreadable response.', {
      code: 'empty_response',
    })
  }
  return data
}

/** Join the text parts of a candidate into one trimmed string. */
function candidateText(data: GeminiResponse): string {
  const parts = data.candidates?.[0]?.content?.parts ?? []
  return parts
    .map((p) => ('text' in p ? p.text : ''))
    .join('')
    .trim()
}

function usageFrom(data: GeminiResponse): AiUsage | null {
  return normalizeUsage({
    prompt: data.usageMetadata?.promptTokenCount,
    completion: data.usageMetadata?.candidatesTokenCount,
    total: data.usageMetadata?.totalTokenCount,
  })
}

/**
 * Call Gemini's `generateContent` endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args
  const data = await postGemini(
    model,
    apiKey,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: normalizeForGemini(messages),
      generationConfig: buildGenConfig(model),
    },
    timeoutMs,
  )
  const text = candidateText(data)
  if (!text) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }
  return { text, usage: usageFrom(data) }
}

/**
 * Gemini with function calling. Runs a bounded model⇄tool loop: offer the
 * model the enabled tools; when it calls one, execute it server-side,
 * feed the result back, and ask again; stop when it returns text (or the
 * round cap is hit). Token usage is summed across every round.
 */
export async function generateGeminiWithTools(
  args: ProviderArgs & { tools: AiTool[]; toolContext: ToolContext },
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, toolContext } = args
  const functionDeclarations = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
  const contents = normalizeForGemini(messages) as GeminiContent[]
  let usage: AiUsage | null = null

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const data = await postGemini(
      model,
      apiKey,
      {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: [{ functionDeclarations }],
        generationConfig: buildGenConfig(model),
      },
      timeoutMs,
    )
    usage = addUsage(usage, usageFrom(data))

    const parts = data.candidates?.[0]?.content?.parts ?? []
    const calls = parts.filter(
      (p): p is Extract<GeminiPart, { functionCall: unknown }> => 'functionCall' in p,
    )

    if (calls.length === 0) {
      // No tool call → the model answered. Done.
      const text = candidateText(data)
      if (text) return { text, usage }
      break
    }

    // Echo the model's turn (with its functionCall parts) back into the
    // transcript, then append one functionResponse per call.
    contents.push({ role: 'model', parts })
    const responseParts: GeminiPart[] = []
    for (const p of calls) {
      const { name, args: callArgs } = p.functionCall
      const tool = tools.find((t) => t.name === name)
      let result: string
      try {
        result = tool
          ? await tool.run(callArgs ?? {}, toolContext)
          : `Unknown tool: ${name}`
      } catch (err) {
        console.error(`[ai tools] "${name}" threw:`, err)
        result = 'The tool could not be run right now.'
      }
      responseParts.push({ functionResponse: { name, response: { result } } })
    }
    contents.push({ role: 'user', parts: responseParts })
  }

  throw new AiError('Gemini did not return an answer after tool calls.', {
    code: 'empty_response',
  })
}
