import { describe, expect, it } from 'vitest'
import { parseSuggestions } from './llm.js'
import type { CheckRequest } from './types.js'

const request: CheckRequest = { text: 'I has a apple. She go home.', capabilities: ['grammar', 'spell'] }

describe('parseSuggestions', () => {
  it('maps quotes to ranges', () => {
    const reply = '[{"quote":"I has","kind":"grammar","message":"Subject-verb","replacements":["I have"],"confidence":0.95}]'
    const [s] = parseSuggestions(reply, request, 'test')
    expect(s).toMatchObject({ range: { start: 0, end: 5 }, kind: 'grammar', replacements: ['I have'], confidence: 0.95 })
  })

  it('tolerates markdown fences and prose around the array', () => {
    const reply = 'Sure! ```json\n[{"quote":"She go","kind":"grammar","message":"m","replacements":["She goes"]}]\n```'
    expect(parseSuggestions(reply, request, 'test')).toHaveLength(1)
  })

  it('drops suggestions whose quote is not in the text', () => {
    const reply = '[{"quote":"nope","kind":"grammar","message":"m","replacements":[]}]'
    expect(parseSuggestions(reply, request, 'test')).toEqual([])
  })

  it('returns [] on garbage', () => {
    expect(parseSuggestions('not json', request, 'test')).toEqual([])
  })

  it('falls back to the first requested capability for unknown kinds', () => {
    const reply = '[{"quote":"a apple","kind":"weird","message":"m","replacements":["an apple"]}]'
    expect(parseSuggestions(reply, request, 'test')[0]?.kind).toBe('grammar')
  })
})
