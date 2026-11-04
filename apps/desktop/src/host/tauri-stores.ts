import { invoke } from '@tauri-apps/api/core'
import { DEFAULT_SETTINGS, type SecretStore, type Settings, type SettingsStore } from '@plumary/core'

/** SecretStore port backed by the macOS Keychain through Rust commands. */
export const keychainSecretStore: SecretStore = {
  get: (key) => invoke<string | null>('secret_get', { key }),
  set: (key, value) => invoke('secret_set', { key, value }),
  delete: (key) => invoke('secret_delete', { key }),
}

/** SettingsStore port backed by a JSON file in the app config dir. */
export const fileSettingsStore: SettingsStore = {
  async load() {
    const stored = await invoke<Partial<Settings> | null>('settings_load')
    return { ...structuredClone(DEFAULT_SETTINGS), ...(stored ?? {}) }
  },
  save: (settings) => invoke('settings_save', { settings }),
}
