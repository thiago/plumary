import { SuggestionCache, cacheKey } from './cache.js'
import { chunkByParagraph } from './chunk.js'
import { mergeSuggestions } from './merge.js'
import type {
  Capability,
  CheckRequest,
  Provider,
  ProviderContext,
  SecretStore,
  Settings,
  SettingsStore,
  Suggestion,
} from './types.js'

export interface EngineOptions {
  providers: Provider[]
  settingsStore: SettingsStore
  secretStore: SecretStore
  fetch?: typeof fetch
  log?: (message: string) => void
}

export interface CheckOptions {
  signal?: AbortSignal
}

export interface CheckError {
  providerId: string
  message: string
}

export interface CheckResult {
  suggestions: Suggestion[]
  /** Provider failures; the suggestions from providers that worked are still returned. */
  errors: CheckError[]
}

/**
 * Orchestrates a check: chunk text → route each capability to its provider →
 * run with cache → map ranges back → merge overlapping results.
 */
export class Engine {
  private readonly providers = new Map<string, Provider>()
  private readonly cache = new SuggestionCache()
  private readonly fetchImpl: typeof fetch
  private readonly log: (message: string) => void
  private settings: Settings | null = null
  /** Secrets resolved this session; avoids hitting the OS keychain on every check. */
  private readonly secrets = new Map<string, string | null>()

  constructor(private readonly options: EngineOptions) {
    for (const p of options.providers) this.providers.set(p.id, p)
    // Keep `fetch` bound to its global: browsers throw "Illegal invocation" when it's
    // called as a method of another object (which is what `ctx.fetch(...)` does).
    const fetchImpl = options.fetch ?? globalThis.fetch
    this.fetchImpl = (input, init) => fetchImpl(input, init)
    this.log = options.log ?? (() => {})
  }

  listProviders(): Provider[] {
    return [...this.providers.values()]
  }

  async getSettings(): Promise<Settings> {
    this.settings ??= await this.options.settingsStore.load()
    return this.settings
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.getSettings()
    this.settings = { ...current, ...patch }
    await this.options.settingsStore.save(this.settings)
    this.reload()
    return this.settings
  }

  /** Forgets cached settings, secrets and results, e.g. after another window changed them. */
  reload(): void {
    this.settings = null
    this.secrets.clear()
    this.cache.clear()
  }

  async check(request: CheckRequest, options: CheckOptions = {}): Promise<CheckResult> {
    const settings = await this.getSettings()
    const signal = options.signal ?? new AbortController().signal
    const plan = this.planRouting(request.capabilities, settings)
    const chunks = chunkByParagraph(request.text)

    const runs = plan.flatMap(({ provider, capabilities }) =>
      chunks.map(async (chunk) => {
        const chunkRequest: CheckRequest = { ...request, text: chunk.text, capabilities }
        try {
          const suggestions = await this.runCached(provider, chunkRequest, settings, signal)
          return suggestions.map((s) => ({
            ...s,
            range: { start: s.range.start + chunk.range.start, end: s.range.end + chunk.range.start },
          }))
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason)
          this.log(`provider ${provider.id} failed: ${message}`)
          throw { providerId: provider.id, message } satisfies CheckError
        }
      }),
    )

    const results = await Promise.allSettled(runs)
    const suggestions: Suggestion[] = []
    const errors = new Map<string, CheckError>()
    for (const r of results) {
      if (r.status === 'fulfilled') suggestions.push(...r.value)
      else errors.set((r.reason as CheckError).providerId, r.reason as CheckError)
    }
    for (const capability of request.capabilities) {
      if (!plan.some((p) => p.capabilities.includes(capability))) {
        errors.set(`routing:${capability}`, { providerId: '', message: `No provider configured for "${capability}"` })
      }
    }
    return { suggestions: mergeSuggestions(suggestions), errors: [...errors.values()] }
  }

  /** Groups requested capabilities by the provider configured for each one. */
  private planRouting(
    capabilities: Capability[],
    settings: Settings,
  ): Array<{ provider: Provider; capabilities: Capability[] }> {
    const byProvider = new Map<Provider, Capability[]>()
    for (const capability of capabilities) {
      const provider = this.resolveProvider(capability, settings)
      if (provider === undefined) {
        this.log(`no provider for capability "${capability}"`)
        continue
      }
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), capability])
    }
    return [...byProvider].map(([provider, caps]) => ({ provider, capabilities: caps }))
  }

  private resolveProvider(capability: Capability, settings: Settings): Provider | undefined {
    const routedId = settings.routing[capability]
    if (routedId !== undefined) {
      const routed = this.providers.get(routedId)
      if (routed?.capabilities.includes(capability)) return routed
    }
    return this.listProviders().find((p) => p.capabilities.includes(capability))
  }

  private async runCached(
    provider: Provider,
    request: CheckRequest,
    settings: Settings,
    signal: AbortSignal,
  ): Promise<Suggestion[]> {
    const key = cacheKey({ provider: provider.id, request })
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit

    const ctx = await this.buildContext(provider, settings, signal)
    const suggestions = await provider.run(request, ctx)
    this.cache.set(key, suggestions)
    return suggestions
  }

  private async buildContext(provider: Provider, settings: Settings, signal: AbortSignal): Promise<ProviderContext> {
    const resolved: ProviderContext['settings'] = { ...(settings.providers[provider.id] ?? {}) }
    for (const [name, field] of Object.entries(provider.settingsSchema.properties)) {
      if (field.secret) {
        resolved[name] = (await this.secret(secretKey(provider.id, name))) ?? undefined
      } else if (resolved[name] === undefined && field.default !== undefined) {
        resolved[name] = field.default
      }
    }
    return { fetch: this.fetchImpl, signal, settings: resolved, log: (m) => this.log(`[${provider.id}] ${m}`) }
  }

  private async secret(key: string): Promise<string | null> {
    if (!this.secrets.has(key)) this.secrets.set(key, await this.options.secretStore.get(key))
    return this.secrets.get(key) ?? null
  }
}

export function secretKey(providerId: string, field: string): string {
  return `${providerId}.${field}`
}
