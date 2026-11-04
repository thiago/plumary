import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'
import { secretKey, type Capability, type Settings as CoreSettings } from '@plumary/core'
import { engine, providers } from './engine'
import { keychainSecretStore } from './host/tauri-stores'

const CAPABILITIES: Capability[] = ['grammar', 'spell', 'translate', 'tone', 'rephrase']

export function Settings() {
  const [settings, setSettings] = useState<CoreSettings | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [trusted, setTrusted] = useState<boolean | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void engine.getSettings().then(setSettings)
    void invoke<boolean>('accessibility_status', { prompt: false }).then(setTrusted)
    const poll = setInterval(() => void invoke<boolean>('accessibility_status', { prompt: false }).then(setTrusted), 2000)
    return () => clearInterval(poll)
  }, [])

  if (!settings) return null

  const setRouting = (cap: Capability, providerId: string) =>
    setSettings({ ...settings, routing: { ...settings.routing, [cap]: providerId || undefined } })

  const setProviderField = (providerId: string, field: string, value: string) =>
    setSettings({ ...settings, providers: { ...settings.providers, [providerId]: { ...settings.providers[providerId], [field]: value } } })

  async function save() {
    for (const [key, value] of Object.entries(secrets)) {
      if (value) await keychainSecretStore.set(key, value)
    }
    await engine.updateSettings(settings!)
    await emit('settings-changed')
    setSecrets({})
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="settings">
      <h1>Plumary</h1>

      <section>
        <h2>Accessibility permission</h2>
        {trusted ? (
          <p className="ok">Granted. Press ⌘⇧G in any text field.</p>
        ) : (
          <p>
            Needed to read and fix text in other apps.{' '}
            <button onClick={() => void invoke('accessibility_status', { prompt: true })}>Grant access…</button>
          </p>
        )}
      </section>

      <section>
        <h2>Who handles what</h2>
        {CAPABILITIES.map((cap) => (
          <label key={cap} className="row">
            <span>{cap}</span>
            <select value={settings.routing[cap] ?? ''} onChange={(e) => setRouting(cap, e.target.value)}>
              <option value="">off</option>
              {providers.filter((p) => p.capabilities.includes(cap)).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        ))}
      </section>

      {providers.map((p) => (
        <section key={p.id}>
          <h2>{p.name}</h2>
          {Object.entries(p.settingsSchema.properties).map(([field, schema]) => {
            const key = secretKey(p.id, field)
            return (
              <label key={field} className="row">
                <span>{schema.title}</span>
                {schema.secret ? (
                  <input type="password" placeholder="stored in Keychain" value={secrets[key] ?? ''} onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })} />
                ) : (
                  <input value={String(settings.providers[p.id]?.[field] ?? schema.default ?? '')} onChange={(e) => setProviderField(p.id, field, e.target.value)} />
                )}
              </label>
            )
          })}
        </section>
      ))}

      <footer>
        <button className="primary" onClick={() => void save()}>Save</button>
        {saved && <span className="ok">Saved</span>}
      </footer>
    </div>
  )
}
