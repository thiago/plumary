import type { Capability, CheckRequest, Suggestion } from './types.js'

/**
 * Shared prompt + parser for any chat-style LLM provider. A provider only has to
 * send `buildPrompt(...)` to its API and hand the reply to `parseSuggestions(...)`.
 */

const CAPABILITY_INSTRUCTIONS: Record<Capability, string> = {
  grammar:
    'Correct grammar and punctuation: missing or extra articles, prepositions and auxiliary verbs, subject-verb agreement, verb tense, pluralisation, word order, and punctuation. Missing words count as mistakes.',
  spell: 'Correct misspelled words. Quote just the misspelled word.',
  translate: 'Translate the whole text to the target language and return it as a single replacement covering the full text.',
  tone: 'Suggest rewrites that match the requested tone, one per sentence that needs it.',
  rephrase: 'Suggest clearer or more concise rewrites for awkward sentences.',
}

export function buildSystemPrompt(): string {
  return [
    'You are a writing assistant. You receive text and return ONLY a JSON array of suggestions, no prose, no markdown fences.',
    'Each suggestion: {"quote": string, "kind": string, "message": string, "replacements": string[], "confidence": number}.',
    '"quote" must be copied verbatim from the input text, as an exact substring. Include the words around the problem that the replacement needs, so the fix reads naturally in place.',
    'Replacing "quote" with any item of "replacements" must yield correct, natural text. For a missing word, quote the words on each side of the gap and put the whole corrected phrase in "replacements" (e.g. quote "went to store", replacement "went to the store").',
    'Prefer the smallest quote that makes the sentence fully correct. When several mistakes in one sentence depend on each other, quote the whole sentence and return it rewritten.',
    '"kind" is one of the requested capabilities. "message" is a short human explanation. "confidence" is 0 to 1.',
    'Return [] when there is nothing to suggest. Never change text that is already correct.',
  ].join('\n')
}

export function buildUserPrompt(request: CheckRequest): string {
  const tasks = request.capabilities.map((c) => `- ${c}: ${CAPABILITY_INSTRUCTIONS[c]}`).join('\n')
  const extras = [
    request.language ? `Text language: ${request.language}.` : 'Detect the text language.',
    request.targetLanguage ? `Target language: ${request.targetLanguage}.` : '',
    request.tone ? `Requested tone: ${request.tone}.` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return `Tasks:\n${tasks}\n${extras}\n\nText:\n<<<\n${request.text}\n>>>`
}

interface RawSuggestion {
  quote?: unknown
  kind?: unknown
  message?: unknown
  replacements?: unknown
  confidence?: unknown
}

/** Tolerant parser: strips fences, finds the array, maps quotes back to ranges. */
export function parseSuggestions(reply: string, request: CheckRequest, providerId: string): Suggestion[] {
  const json = extractJsonArray(reply)
  if (json === null) return []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const result: Suggestion[] = []
  let searchFrom = 0
  for (const item of raw as RawSuggestion[]) {
    if (typeof item?.quote !== 'string' || typeof item.message !== 'string') continue
    const kind = request.capabilities.includes(item.kind as Capability)
      ? (item.kind as Capability)
      : request.capabilities[0]
    if (kind === undefined) continue
    const replacements = Array.isArray(item.replacements)
      ? item.replacements.filter((r): r is string => typeof r === 'string')
      : []
    const start = locateQuote(request.text, item.quote, searchFrom)
    if (start === -1) continue
    searchFrom = start
    const suggestion: Suggestion = {
      range: { start, end: start + item.quote.length },
      kind,
      message: item.message,
      replacements,
      providerId,
    }
    if (typeof item.confidence === 'number') suggestion.confidence = clamp01(item.confidence)
    result.push(suggestion)
  }
  return result
}

function locateQuote(text: string, quote: string, from: number): number {
  const forward = text.indexOf(quote, from)
  return forward !== -1 ? forward : text.indexOf(quote)
}

function extractJsonArray(reply: string): string | null {
  const unfenced = reply.replace(/```(?:json)?/gi, '').trim()
  const start = unfenced.indexOf('[')
  const end = unfenced.lastIndexOf(']')
  return start === -1 || end <= start ? null : unfenced.slice(start, end + 1)
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}
