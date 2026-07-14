import { env } from 'node:process'
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
// A real generation is well under this (the relay sustains ~130-170 tok/s); the cap
// exists so an occasional relay STALL fails fast and the attempt retries, instead of
// the raw fetch hanging for minutes with no timeout (the cause of the "nothing
// happens for ages" stalls). Override with LEARNING_LLM_TIMEOUT_MS if needed.
const LLM_TIMEOUT_MS = Number.parseInt(env.LEARNING_LLM_TIMEOUT_MS || '90000')

// Transient endpoint errors that are worth retrying with backoff rather than failing the
// objective immediately: 429 (rate limit — common when a burst of retries hammers a cloud
// model), 5xx, and network/abort (a relay hiccup). 4xx other than 429 (auth, bad model) are
// NOT retried — they won't fix themselves. An OK response with EMPTY content is also not
// retried (that's a model issue, not a transient transport one).
const LLM_MAX_RETRIES = Number.parseInt(env.LEARNING_LLM_MAX_RETRIES || '4')
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function complete(options: CompleteOptions): Promise<string | null> {
  const baseURL = openaiConfig.baseUrl || 'https://api.openai.com/v1'
  const model = options.model || openaiConfig.model
  const startedAt = Date.now()
  // Backoff schedule (ms) between transient-error retries — exponential so a rate limit has
  // time to reset without hammering. 2s, 4s, 8s, 16s caps a 4-retry wait at ~30s.
  const backoffMs = [2000, 4000, 8000, 16000]
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS)
    try {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        // eslint-disable-next-line ts/naming-convention -- standard HTTP header names
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiConfig.apiKey || 'sk-no-key'}` },
        body: JSON.stringify({
          // Empty model -> fall back to the configured OPENAI_MODEL (e.g. criticModel='').
          model,
          stream: false,
          temperature: options.temperature ?? 0,
          messages: [
            { role: 'system', content: options.system },
            { role: 'user', content: options.user },
          ],
        }),
      })
      if (!response.ok) {
        const transient = response.status === 429 || response.status >= 500
        logger.withFields({ status: response.status, model, attempt, transient }).warn('LLM endpoint returned a non-OK status')
        if (transient && attempt < LLM_MAX_RETRIES) {
          await sleep(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1]!)
          continue
        }
        return null
      }
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>, usage?: { prompt_tokens?: number, completion_tokens?: number } }
      const content = data.choices?.[0]?.message?.content ?? null
      // Per-call latency + token accounting, so a slow call shows whether it's input
      // size, output size, or the call itself hanging.
      const secs = (Date.now() - startedAt) / 1000
      const inTok = data.usage?.prompt_tokens ?? -1
      const outTok = data.usage?.completion_tokens ?? Math.round((content?.length ?? 0) / 4)
      logger.withFields({ model, inTok, outTok, secs: Number(secs.toFixed(1)), tps: secs > 0 && outTok > 0 ? Number((outTok / secs).toFixed(1)) : 0 }).log('LLM call')
      if (!content) {
        logger.withFields({ model }).warn('LLM returned no content (check the model name and endpoint)')
      }
      return content
    }
    catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError'
      const msg = aborted ? `timed out after ${LLM_TIMEOUT_MS}ms` : (e instanceof Error ? e.message : String(e))
      // A network blip / abort is transient — retry with backoff; a genuine unreachable endpoint
      // will exhaust the retries and return null (the caller retries the objective anyway).
      logger.withFields({ error: msg, model, attempt }).warn('LLM request failed (is the endpoint reachable?)')
      if (attempt < LLM_MAX_RETRIES) {
        await sleep(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1]!)
        continue
      }
      return null
    }
    finally {
      clearTimeout(timer)
    }
  }
  return null
}
