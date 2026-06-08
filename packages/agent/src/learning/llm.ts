import { useLogg } from '@guiiai/logg'
import { openaiConfig } from '../config'

const logger = useLogg('learning-llm').useGlobalConfig()

export interface CompleteOptions {
  system: string
  /** A plain string, or OpenAI vision-style content parts (text + image_url). */
  user: string | unknown[]
  model: string
  temperature?: number
}

/**
 * One plain chat completion against the configured OpenAI-compatible endpoint
 * (no tools, no streaming) — used by the critic, curriculum and skill-describer.
 * Mirrors the raw-fetch approach already proven for vision in main.ts. Returns
 * the assistant text, or null on any failure.
 */
export async function complete(options: CompleteOptions): Promise<string | null> {
  const baseURL = openaiConfig.baseUrl || 'https://api.openai.com/v1'
  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      // eslint-disable-next-line ts/naming-convention -- standard HTTP header names
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiConfig.apiKey || 'sk-no-key'}` },
      body: JSON.stringify({
        // Empty model -> fall back to the configured OPENAI_MODEL (e.g. criticModel='').
        model: options.model || openaiConfig.model,
        stream: false,
        temperature: options.temperature ?? 0,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
      }),
    })
    if (!response.ok) {
      logger.withFields({ status: response.status, model: options.model || openaiConfig.model }).warn('LLM endpoint returned a non-OK status')
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content ?? null
    if (!content) {
      logger.withFields({ model: options.model || openaiConfig.model }).warn('LLM returned no content (check the model name and endpoint)')
    }
    return content
  }
  catch (e) {
    logger.withFields({ error: e instanceof Error ? e.message : String(e) }).warn('LLM request failed (is the endpoint reachable?)')
    return null
  }
}
