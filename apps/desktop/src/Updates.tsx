import { getVersion } from '@tauri-apps/api/app'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { useEffect, useState } from 'react'

type State =
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'available'; update: Update }
  | { kind: 'downloading'; version: string }
  | { kind: 'error'; message: string }

/** Shows the current version and, when a newer release exists, offers a one-click update. */
export function Updates() {
  const [version, setVersion] = useState('')
  const [state, setState] = useState<State>({ kind: 'checking' })

  useEffect(() => {
    void getVersion().then(setVersion)
    void runCheck()
  }, [])

  async function runCheck() {
    setState({ kind: 'checking' })
    try {
      const update = await check()
      setState(update ? { kind: 'available', update } : { kind: 'latest' })
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  async function install(update: Update) {
    setState({ kind: 'downloading', version: update.version })
    try {
      await update.downloadAndInstall()
      await relaunch()
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <section>
      <h2>Updates</h2>
      <label className="row">
        <span>Version</span>
        <span className="muted">{version || '—'}</span>
      </label>
      {state.kind === 'checking' && <p className="muted">Checking for updates…</p>}
      {state.kind === 'latest' && (
        <p>
          <span className="ok">You&apos;re on the latest version.</span>{' '}
          <button onClick={() => void runCheck()}>Check again</button>
        </p>
      )}
      {state.kind === 'available' && (
        <p>
          Version {state.update.version} is available.{' '}
          <button className="primary" onClick={() => void install(state.update)}>Download &amp; install</button>
        </p>
      )}
      {state.kind === 'downloading' && <p className="muted">Downloading {state.version}… Plumary will restart when it is ready.</p>}
      {state.kind === 'error' && (
        <p>
          <span className="muted">Couldn&apos;t check for updates.</span>{' '}
          <button onClick={() => void runCheck()}>Retry</button>
        </p>
      )}
    </section>
  )
}
