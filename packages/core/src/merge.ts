import type { Suggestion } from './types.js'

/**
 * Drops suggestions that overlap an earlier, higher-confidence one and sorts by position.
 * Keeps the first of equal-confidence overlaps so provider order is a tiebreaker.
 */
export function mergeSuggestions(suggestions: Suggestion[]): Suggestion[] {
  const byPriority = [...suggestions].sort(
    (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || a.range.start - b.range.start,
  )
  const kept: Suggestion[] = []
  for (const candidate of byPriority) {
    if (!kept.some((s) => overlaps(s, candidate))) kept.push(candidate)
  }
  return kept.sort((a, b) => a.range.start - b.range.start)
}

function overlaps(a: Suggestion, b: Suggestion): boolean {
  return a.range.start < b.range.end && b.range.start < a.range.end
}
