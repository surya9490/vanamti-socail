import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic, generateAnthropicWithTools } from './providers/anthropic'
import { generateGemini, generateGeminiWithTools } from './providers/gemini'
import type { AiTool, ToolContext } from './tools/registry'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** Function-calling tools to offer the model. Currently honoured by the
   *  Gemini provider only; ignored for others (they answer text-only). */
  tools?: AiTool[]
  /** Per-conversation context passed to a tool's `run`. Required when
   *  `tools` is non-empty. */
  toolContext?: ToolContext
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  // Tool (function) calling is supported by Gemini and Anthropic. When
  // tools are enabled and the provider has a tool-loop adapter, run it;
  // OpenAI (no adapter yet) falls through to a plain text generation
  // that ignores any tools passed. Adding OpenAI's function calling is a
  // future PR — the code path is deliberately identical so slotting in
  // `generateOpenAiWithTools` is a one-line change here.
  const hasTools =
    args.tools !== undefined && args.tools.length > 0 && args.toolContext !== undefined
  if (hasTools && config.provider === 'gemini') {
    result = await generateGeminiWithTools({
      ...providerArgs,
      tools: args.tools!,
      toolContext: args.toolContext!,
    })
  } else if (hasTools && config.provider === 'anthropic') {
    result = await generateAnthropicWithTools({
      ...providerArgs,
      tools: args.tools!,
      toolContext: args.toolContext!,
    })
  } else {
    switch (config.provider) {
      case 'openai':
        result = await generateOpenAi(providerArgs)
        break
      case 'anthropic':
        result = await generateAnthropic(providerArgs)
        break
      case 'gemini':
        result = await generateGemini(providerArgs)
        break
      default:
        throw new AiError(`Unsupported AI provider: ${config.provider}`, {
          code: 'unsupported_provider',
          status: 400,
        })
    }
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}
