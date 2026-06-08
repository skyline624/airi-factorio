// Lenient JSON recovery for LLM output (which may be wrapped in code fences or
// surrounding prose) and for Lua `helpers.table_to_json` replies (which may be
// bare arrays). Returns null instead of throwing so callers can fall back.

export function extractJsonObject(text: string): string {
  const fenceMatch = text.match(/```(?:json5?)?([\s\S]*?)```/i)
  const candidate = fenceMatch ? fenceMatch[1] : text

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start !== -1 && end > start) {
    return candidate.slice(start, end + 1)
  }

  return candidate.trim()
}

/**
 * Recover the JSON that an `rcon.print` produced from a raw RCON-API reply. The
 * RCON-API prepends the echoed `… [COMMAND] <server> (command): <lua>` line,
 * whose Lua contains braces (e.g. `find_entities_filtered{…}`, `{remote.call(…)}`)
 * that would corrupt a naive first-brace/last-brace scan. The printed JSON is the
 * last (single) line, so we scan from the end for the first parseable line.
 */
export function extractLastJsonLine<T = unknown>(output: string | null | undefined): T | null {
  if (!output) {
    return null
  }
  const lines = output.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) {
      continue
    }
    const parsed = parseJsonLoose<T>(line)
    if (parsed !== null) {
      return parsed
    }
  }
  return null
}

export function parseJsonLoose<T = unknown>(text: string | null | undefined): T | null {
  if (!text) {
    return null
  }

  // A straight parse first: covers clean objects AND bare arrays (op return values).
  try {
    return JSON.parse(text.trim()) as T
  }
  catch {
    // fall through to fence/prose recovery
  }

  try {
    return JSON.parse(extractJsonObject(text)) as T
  }
  catch {
    return null
  }
}
