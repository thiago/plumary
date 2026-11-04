import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'
import type { Capability, Suggestion } from '@plumary/core'
import { engine } from './engine'

type Mode = 'accessibility' | 'paste' | 'clipboard'

interface CheckRequestEvent {
  text: string
  selection_start: number
  selection_end: number
  mode: Mode
}

const DEFAULT_CAPABILITIES: Capability[] = ['grammar', 'spell']

type Status = { kind: 'idle' } | { kind: 'checking' } | { kind: 'done' } | { kind: 'error'; message: string }

export function Panel() {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<Mode>('accessibility')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let abort = new AbortController()
    const unlisten = listen<CheckRequestEvent>('check-request', async ({ payload }) => {
      abort.abort()
      abort = new AbortController()
      const { signal } = abort
      setText(payload.text)
      setMode(payload.mode)
      setSuggestions([])
      setCopied(false)
      setStatus({ kind: 'checking' })
      try {
        const settings = await engine.getSettings()
        const capabilities = (Object.keys(settings.routing) as Capability[]).filter((c) => settings.routing[c])
        const result = await engine.check(
          { text: payload.text, capabilities: capabilities.length ? capabilities : DEFAULT_CAPABILITIES, ...(settings.language ? { language: settings.language } : {}) },
          { signal },
        )
        // A newer request superseded this one; its own handler owns the UI now.
        if (signal.aborted) return
        setSuggestions(result.suggestions)
        setStatus(result.errors.length ? { kind: 'error', message: result.errors.map((e) => e.message).join(' · ') } : { kind: 'done' })
      } catch (e) {
        if (signal.aborted) return
        setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    })
    const unlistenSettings = listen('settings-changed', () => engine.reload())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void invoke('dismiss_panel')
    }
    window.addEventListener('keydown', onKey)
    return () => {
      void unlisten.then((f) => f())
      void unlistenSettings.then((f) => f())
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  async function apply(s: Suggestion, replacement: string) {
    try {
      const applied = await invoke<Mode>('apply_edit', { start: s.range.start, end: s.range.end, replacement })
      if (applied === 'clipboard') setCopied(true)
      const delta = replacement.length - (s.range.end - s.range.start)
      setText((t) => t.slice(0, s.range.start) + replacement + t.slice(s.range.end))
      setSuggestions((list) =>
        list
          .filter((o) => o !== s)
          .map((o) => (o.range.start >= s.range.end ? { ...o, range: { start: o.range.start + delta, end: o.range.end + delta } } : o)),
      )
    } catch (e) {
      setStatus({ kind: 'error', message: `Could not apply: ${String(e)}` })
    }
  }

  return (
    <div className="panel">
      <header>
        <strong>Plumary</strong>
        <span className="muted">
          {status.kind === 'checking' && 'checking…'}
          {status.kind === 'done' && `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}`}
        </span>
        <button className="icon" title="Settings" onClick={() => void invoke('open_settings')}>⚙</button>
        <button className="icon" title="Close (Esc)" onClick={() => void invoke('dismiss_panel')}>✕</button>
      </header>

      {mode === 'clipboard' && (
        <p className="notice">This app doesn't expose its text. {copied ? 'Replacement copied: press ⌘V in the app.' : 'Clicking a fix copies it to the clipboard.'}</p>
      )}
      {status.kind === 'error' && <p className="error">{status.message}</p>}
      {status.kind === 'done' && suggestions.length === 0 && <p className="muted center">Looks good.</p>}

      <ul className="suggestions">
        {suggestions.map((s) => (
          <li key={`${s.range.start}-${s.range.end}-${s.providerId}`} className={`kind-${s.kind}`}>
            <div className="line">
              <del>{text.slice(s.range.start, s.range.end)}</del>
              {s.replacements.map((r) => (
                <button key={r} className="fix" onClick={() => void apply(s, r)}>{r}</button>
              ))}
            </div>
            <p className="message">{s.message}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
