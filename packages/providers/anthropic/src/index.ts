import { buildSystemPrompt, buildUserPrompt, parseSuggestions, type Provider } from '@plumary/core'

const DEFAULT_MODEL = 'claude-sonnet-5-5'
const DEFAULT_MAX_TOKENS = 2048
const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

export const anthropicProvider: Provider = {
  id: 'anthropic',
  name: 'Anthropic Claude',
  capabilities: ['grammar', 'spell', 'translate', 'tone', 'rephrase'],
  settingsSchema: {
    type: 'object',
    required: ['apiKey'],
    properties: {
      apiKey: { type: 'string', title: 'API key', secret: true },
      model: { type: 'string', title: 'Model', default: DEFAULT_MODEL },
    },
  },
  async run(request, ctx) {
    const apiKey = ctx.settings['apiKey']
    if (typeof apiKey !== 'string' || apiKey === '') throw new Error('anthropic: apiKey is not set')

    const response = await ctx.fetch(API_URL, {
      method: 'POST',
      signal: ctx.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: ctx.settings['model'] ?? DEFAULT_MODEL,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: buildUserPrompt(request) }],
      }),
    })
    if (!response.ok) throw new Error(`anthropic: HTTP ${response.status} ${await response.text()}`)

    const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> }
    const text = body.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? ''
    return parseSuggestions(text, request, anthropicProvider.id)
  },
}

export default anthropicProvider
