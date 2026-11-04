import { describe, expect, it, vi } from 'vitest'
import { Engine } from './engine.js'
import { MemorySecretStore, MemorySettingsStore } from './memory-stores.js'
import type { Provider, Suggestion } from './types.js'

function fakeProvider(id: string, capabilities: Provider['capabilities'], run = vi.fn()): Provider {
  run.mockImplementation(async (req): Promise<Suggestion[]> =>
    req.text.includes('bad')
      ? [{ range: { start: req.text.indexOf('bad'), end: req.text.indexOf('bad') + 3 }, kind: capabilities[0]!, message: 'bad', replacements: ['good'], providerId: id }]
      : [],
  )
  return { id, name: id, capabilities, settingsSchema: { type: 'object', properties: {} }, run }
}

function makeEngine(providers: Provider[], routing = {}) {
  return new Engine({
    providers,
    settingsStore: new MemorySettingsStore({ routing, providers: {} }),
    secretStore: new MemorySecretStore(),
    fetch: vi.fn() as unknown as typeof fetch,
  })
}

describe('Engine', () => {
  it('maps chunk-relative ranges back to absolute offsets', async () => {
    const engine = makeEngine([fakeProvider('a', ['grammar'])])
    const { suggestions } = await engine.check({ text: 'fine.\n\nthis is bad', capabilities: ['grammar'] })
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.range).toEqual({ start: 15, end: 18 })
  })

  it('routes each capability to the configured provider', async () => {
    const grammarRun = vi.fn()
    const spellRun = vi.fn()
    const engine = makeEngine(
      [fakeProvider('g', ['grammar', 'spell'], grammarRun), fakeProvider('s', ['spell'], spellRun)],
      { spell: 's' },
    )
    await engine.check({ text: 'x', capabilities: ['grammar', 'spell'] })
    expect(grammarRun).toHaveBeenCalledWith(expect.objectContaining({ capabilities: ['grammar'] }), expect.anything())
    expect(spellRun).toHaveBeenCalledWith(expect.objectContaining({ capabilities: ['spell'] }), expect.anything())
  })

  it('caches identical requests per provider', async () => {
    const run = vi.fn()
    const engine = makeEngine([fakeProvider('a', ['grammar'], run)])
    await engine.check({ text: 'same', capabilities: ['grammar'] })
    await engine.check({ text: 'same', capabilities: ['grammar'] })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reports a failing provider instead of throwing', async () => {
    const broken: Provider = { ...fakeProvider('b', ['grammar']), run: async () => { throw new Error('boom') } }
    const engine = makeEngine([broken])
    const result = await engine.check({ text: 'x', capabilities: ['grammar'] })
    expect(result.suggestions).toEqual([])
    expect(result.errors).toEqual([{ providerId: 'b', message: 'boom' }])
  })

  it('reports capabilities nobody can handle', async () => {
    const engine = makeEngine([fakeProvider('a', ['grammar'])])
    const result = await engine.check({ text: 'x', capabilities: ['grammar', 'translate'] })
    expect(result.errors.map((e) => e.message)).toEqual(['No provider configured for "translate"'])
  })

  it('resolves secrets into the provider context', async () => {
    const run = vi.fn().mockResolvedValue([])
    const provider: Provider = {
      ...fakeProvider('a', ['grammar'], run),
      settingsSchema: { type: 'object', properties: { apiKey: { type: 'string', title: 'Key', secret: true } } },
    }
    const secrets = new MemorySecretStore()
    await secrets.set('a.apiKey', 'sk-test')
    const engine = new Engine({ providers: [provider], settingsStore: new MemorySettingsStore(), secretStore: secrets })
    await engine.check({ text: 'x', capabilities: ['grammar'] })
    expect(run.mock.calls[0]?.[1].settings.apiKey).toBe('sk-test')
  })
})

describe('Engine secret caching', () => {
  it('reads a secret from the store once per session and again after reload()', async () => {
    const provider: Provider = {
      ...fakeProvider('a', ['grammar']),
      settingsSchema: { type: 'object', properties: { apiKey: { type: 'string', title: 'Key', secret: true } } },
    }
    const secrets = new MemorySecretStore()
    await secrets.set('a.apiKey', 'k1')
    const get = vi.spyOn(secrets, 'get')
    const engine = new Engine({ providers: [provider], settingsStore: new MemorySettingsStore(), secretStore: secrets })
    await engine.check({ text: 'one', capabilities: ['grammar'] })
    await engine.check({ text: 'two', capabilities: ['grammar'] })
    expect(get).toHaveBeenCalledTimes(1)
    engine.reload()
    await engine.check({ text: 'three', capabilities: ['grammar'] })
    expect(get).toHaveBeenCalledTimes(2)
  })
})

describe('Engine fetch binding', () => {
  it('passes a fetch that does not depend on `this`', async () => {
    const calls: unknown[] = []
    const strictFetch = function (this: unknown, ...args: unknown[]) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      calls.push(args)
      return Promise.resolve(new Response('[]'))
    } as unknown as typeof fetch
    const provider: Provider = { ...fakeProvider('a', ['grammar']), run: async (_req, ctx) => { await ctx.fetch('https://x'); return [] } }
    const engine = new Engine({
      providers: [provider],
      settingsStore: new MemorySettingsStore(),
      secretStore: new MemorySecretStore(),
      fetch: strictFetch,
    })
    await expect(engine.check({ text: 'x', capabilities: ['grammar'] })).resolves.toMatchObject({ errors: [] })
    expect(calls).toHaveLength(1)
  })
})
