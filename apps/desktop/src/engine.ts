import { Engine } from '@plumary/core'
import { anthropicProvider } from '@plumary/provider-anthropic'
import { ollamaProvider } from '@plumary/provider-ollama'
import { fileSettingsStore, keychainSecretStore } from './host/tauri-stores'

export const providers = [anthropicProvider, ollamaProvider]

export const engine = new Engine({
  providers,
  settingsStore: fileSettingsStore,
  secretStore: keychainSecretStore,
  log: (m) => console.warn(m),
})
