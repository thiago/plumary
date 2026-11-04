import type { Suggestion } from './types.js'

const DEFAULT_MAX_ENTRIES = 500

/** LRU cache keyed by provider + request fingerprint. Keeps retyping cheap. */
export class SuggestionCache {
  private readonly entries = new Map<string, Suggestion[]>()

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  get(key: string): Suggestion[] | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: string, value: Suggestion[]): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}

export function cacheKey(parts: Record<string, unknown>): string {
  return JSON.stringify(parts)
}
