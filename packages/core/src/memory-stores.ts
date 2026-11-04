import { DEFAULT_SETTINGS, type SecretStore, type Settings, type SettingsStore } from './types.js'

/** In-memory ports for tests and quick experiments. */
export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.secrets.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.secrets.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.secrets.delete(key)
  }
}

export class MemorySettingsStore implements SettingsStore {
  constructor(private settings: Settings = structuredClone(DEFAULT_SETTINGS)) {}
  async load(): Promise<Settings> {
    return this.settings
  }
  async save(settings: Settings): Promise<void> {
    this.settings = settings
  }
}
