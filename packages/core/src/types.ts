/** Everything a provider can do. Providers declare a subset. */
export type Capability = 'grammar' | 'spell' | 'translate' | 'tone' | 'rephrase'

/** Character offsets into the request text, end exclusive. */
export interface TextRange {
  start: number
  end: number
}

export interface Suggestion {
  range: TextRange
  kind: Capability
  message: string
  replacements: string[]
  /** 0..1; omitted when the provider cannot estimate it. */
  confidence?: number
  providerId: string
}

export interface CheckRequest {
  text: string
  capabilities: Capability[]
  /** BCP-47 tag of the text; undefined = let the provider detect. */
  language?: string
  /** Only for `translate`. */
  targetLanguage?: string
  /** Only for `tone` / `rephrase`, free-form, e.g. "formal", "friendly". */
  tone?: string
}

/** Minimal JSON Schema subset used to render a provider's settings form. */
export interface SettingsSchema {
  type: 'object'
  properties: Record<string, SettingField>
  required?: string[]
}

export interface SettingField {
  type: 'string' | 'number' | 'boolean'
  title: string
  description?: string
  default?: string | number | boolean
  /** Rendered as a password input and stored in SecretStore, not SettingsStore. */
  secret?: boolean
  enum?: string[]
}

export interface ProviderContext {
  fetch: typeof fetch
  signal: AbortSignal
  /** Values for this provider's `settingsSchema`, secrets already resolved. */
  settings: Record<string, string | number | boolean | undefined>
  log: (message: string) => void
}

export interface Provider {
  id: string
  name: string
  capabilities: Capability[]
  settingsSchema: SettingsSchema
  run(request: CheckRequest, ctx: ProviderContext): Promise<Suggestion[]>
}

/** A provider plugin: a module that exports one of these as default. */
export type ProviderPlugin = Provider | (() => Provider)

// ---- ports the host platform implements ----

export interface SecretStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface SettingsStore {
  load(): Promise<Settings>
  save(settings: Settings): Promise<void>
}

export interface Settings {
  /** Which provider handles which capability. */
  routing: Partial<Record<Capability, string>>
  /** Non-secret settings per provider id. */
  providers: Record<string, Record<string, string | number | boolean>>
  language?: string
}

export const DEFAULT_SETTINGS: Settings = { routing: {}, providers: {} }
