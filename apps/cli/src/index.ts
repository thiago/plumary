#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { Engine, MemorySettingsStore, secretKey, type Capability, type SecretStore } from '@plumary/core'
import { anthropicProvider } from '@plumary/provider-anthropic'
import { ollamaProvider } from '@plumary/provider-ollama'

/**
 * Smoke-test CLI. Reads text from a file or stdin, checks it with the chosen provider.
 *   plumary --provider ollama --caps grammar,spell file.txt
 *   echo "I has a apple" | plumary --provider anthropic
 * Secrets come from env: ANTHROPIC_API_KEY. Non-secret settings via PLUMARY_MODEL.
 */

const DEFAULT_CAPABILITIES: Capability[] = ['grammar', 'spell']

const args = parseArgs(process.argv.slice(2))
const providerId = args['provider'] ?? 'ollama'
const capabilities = (args['caps']?.split(',') as Capability[] | undefined) ?? DEFAULT_CAPABILITIES
const file = args['_']
const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')

const envSecrets: SecretStore = {
  async get(key) {
    return key === secretKey('anthropic', 'apiKey') ? (process.env['ANTHROPIC_API_KEY'] ?? null) : null
  },
  async set() {},
  async delete() {},
}

const model = process.env['PLUMARY_MODEL']
const engine = new Engine({
  providers: [anthropicProvider, ollamaProvider],
  settingsStore: new MemorySettingsStore({
    routing: Object.fromEntries(capabilities.map((c) => [c, providerId])),
    providers: model ? { [providerId]: { model } } : {},
  }),
  secretStore: envSecrets,
  log: (m) => console.error(m),
})

const started = Date.now()
const { suggestions, errors } = await engine.check({ text, capabilities })
console.error(`${suggestions.length} suggestion(s) from ${providerId} in ${Date.now() - started}ms`)
for (const e of errors) console.error(`error: ${e.providerId ? `${e.providerId}: ` : ''}${e.message}`)
for (const s of suggestions) {
  const original = text.slice(s.range.start, s.range.end)
  console.log(`[${s.kind}] "${original}" → ${s.replacements.map((r) => `"${r}"`).join(' | ') || '(no replacement)'}`)
  console.log(`   ${s.message}`)
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('--')) out[arg.slice(2)] = argv[++i] ?? ''
    else out['_'] = arg
  }
  return out
}
