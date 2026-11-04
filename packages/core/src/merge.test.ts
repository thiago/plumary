import { describe, expect, it } from 'vitest'
import { mergeSuggestions } from './merge.js'
import type { Suggestion } from './types.js'

const make = (start: number, end: number, confidence?: number, providerId = 'p'): Suggestion => ({
  range: { start, end },
  kind: 'grammar',
  message: '',
  replacements: [],
  providerId,
  ...(confidence === undefined ? {} : { confidence }),
})

describe('mergeSuggestions', () => {
  it('sorts by position', () => {
    expect(mergeSuggestions([make(10, 12), make(0, 2)]).map((s) => s.range.start)).toEqual([0, 10])
  })

  it('keeps the higher-confidence suggestion when ranges overlap', () => {
    const kept = mergeSuggestions([make(0, 5, 0.3, 'low'), make(3, 8, 0.9, 'high')])
    expect(kept).toHaveLength(1)
    expect(kept[0]?.providerId).toBe('high')
  })

  it('keeps adjacent non-overlapping suggestions', () => {
    expect(mergeSuggestions([make(0, 5), make(5, 8)])).toHaveLength(2)
  })
})
