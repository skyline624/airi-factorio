import type { RetrievedSkill } from './action'
import type { Skill } from './types'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { useLogg } from '@guiiai/logg'
import { openaiConfig } from '../config'
import descriptionPrompt from '../llm/prompt-skill-description.md?raw'
import { complete } from './llm'

const logger = useLogg('skill-library').useGlobalConfig()

interface StoredSkill extends Skill {
  /** Embedding of the description, used for similarity retrieval. */
  embedding: number[]
}

export interface SkillLibraryDeps {
  /** Directory to persist skills.json + code/<name>.js. Omit for in-memory only (tests). */
  dir?: string
  embeddingModel: string
  /** Base URL for the embeddings endpoint (empty -> reuse OPENAI_API_BASEURL). */
  embeddingBaseUrl?: string
  /** Model that writes the one-line skill description. */
  descriptionModel: string
  /** Injectable for tests. */
  embed?: (text: string) => Promise<number[] | null>
  /** Injectable for tests. */
  complete?: typeof complete
}

export interface SkillLibrary {
  retrieve: (query: string, k?: number) => Promise<RetrievedSkill[]>
  add: (input: { name: string, code: string, objective: string }) => Promise<Skill | null>
  get: (name: string) => Skill | undefined
  summary: () => { name: string, description: string }[]
  size: () => number
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0
  }
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) {
    return 0
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function defaultEmbed(text: string, model: string, baseUrl?: string): Promise<number[] | null> {
  const url = baseUrl || openaiConfig.baseUrl || 'https://api.openai.com/v1'
  try {
    const response = await fetch(`${url}/embeddings`, {
      method: 'POST',
      // eslint-disable-next-line ts/naming-convention -- standard HTTP header names
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiConfig.apiKey || 'sk-no-key'}` },
      body: JSON.stringify({ model, input: text }),
    })
    const data = await response.json() as { data?: Array<{ embedding?: number[] }> }
    return data.data?.[0]?.embedding ?? null
  }
  catch (e) {
    logger.withFields({ error: e instanceof Error ? e.message : String(e) }).warn('Embedding request failed (is the embedding model pulled & endpoint reachable?)')
    return null
  }
}

/**
 * The Voyager-style skill library: learned skills (LLM-generated code) indexed by
 * an embedding of their description. New code is added only after a verified
 * success; retrieval returns the top-k most relevant skills' source to inject into
 * the action prompt (and to invoke via `ops.skill`). Persists to JSON + code files.
 */
export function createSkillLibrary(deps: SkillLibraryDeps): SkillLibrary {
  const skills = new Map<string, StoredSkill>()
  const embed = deps.embed ?? (text => defaultEmbed(text, deps.embeddingModel, deps.embeddingBaseUrl))
  const call = deps.complete ?? complete
  const manifestPath = deps.dir ? join(deps.dir, 'skills.json') : undefined

  if (manifestPath && existsSync(manifestPath)) {
    try {
      const arr = JSON.parse(readFileSync(manifestPath, 'utf-8')) as StoredSkill[]
      for (const s of arr) {
        skills.set(s.name, s)
      }
      logger.withFields({ count: skills.size }).log('Loaded skill library')
    }
    catch (e) {
      logger.withFields({ error: e instanceof Error ? e.message : String(e) }).warn('Failed to load skill library; starting empty')
    }
  }

  function persist() {
    if (!deps.dir || !manifestPath) {
      return
    }
    try {
      mkdirSync(deps.dir, { recursive: true })
      writeFileSync(manifestPath, JSON.stringify([...skills.values()], null, 2), 'utf-8')
      const codeDir = join(deps.dir, 'code')
      mkdirSync(codeDir, { recursive: true })
      for (const s of skills.values()) {
        writeFileSync(join(codeDir, `${s.name}.js`), s.code, 'utf-8')
      }
    }
    catch (e) {
      logger.withFields({ error: e instanceof Error ? e.message : String(e) }).warn('Failed to persist skill library')
    }
  }

  return {
    size: () => skills.size,
    get: name => skills.get(name),
    summary: () => [...skills.values()].map(s => ({ name: s.name, description: s.description })),

    async retrieve(query, k = 5) {
      if (skills.size === 0) {
        return []
      }
      const queryVec = await embed(query)
      if (!queryVec) {
        return []
      }
      return [...skills.values()]
        .map(s => ({ s, score: cosineSimilarity(queryVec, s.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map(({ s }) => ({ name: s.name, description: s.description, code: s.code }))
    },

    async add({ name, code, objective }) {
      if (!name || !code) {
        return null
      }
      let description = `Skill for: ${objective}`
      const generated = await call({ system: descriptionPrompt, user: code, model: deps.descriptionModel })
      if (generated && generated.trim()) {
        description = (generated.trim().split('\n')[0] ?? '').slice(0, 240)
      }
      const embedding = (await embed(description)) ?? []
      const existing = skills.get(name)
      const skill: StoredSkill = {
        name,
        description,
        code,
        objective,
        uses: existing ? existing.uses + 1 : 0,
        createdAt: existing?.createdAt ?? Date.now(),
        embedding,
      }
      skills.set(name, skill)
      persist()
      logger.withFields({ name, description, total: skills.size }).log('Learned a new skill')
      return skill
    },
  }
}
