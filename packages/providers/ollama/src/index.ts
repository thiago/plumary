import { buildSystemPrompt, buildUserPrompt, parseSuggestions, type Provider } from '@plumary/core'

const DEFAULT_BASE_URL = 'http://localhost:11434'
const DEFAULT_MODEL = 'llama3.2'

export const ollamaProvider: Provider = {
  id: 'ollama',
  name: 'Ollama (local)',
  capabilities: ['grammar', 'spell', 'translate', 'tone', 'rephrase'],
  settingsSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', title: 'Base URL', default: DEFAULT_BASE_URL },
      model: { type: 'string', title: 'Model', default: DEFAULT_MODEL },
    },
  },
  async run(request, ctx) {
    const baseUrl = String(ctx.settings['baseUrl'] ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    const response = await ctx.fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal: ctx.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ctx.settings['model'] ?? DEFAULT_MODEL,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserPrompt(request) },
        ],
      }),
    })
    if (!response.ok) throw new Error(`ollama: HTTP ${response.status} ${await response.text()}`)

    const body = (await response.json()) as { message?: { content?: string } }
    return parseSuggestions(body.message?.content ?? '', request, ollamaProvider.id)
  },
}

export default ollamaProvider
