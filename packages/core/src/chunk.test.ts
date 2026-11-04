import { describe, expect, it } from 'vitest'
import { chunkByParagraph } from './chunk.js'

describe('chunkByParagraph', () => {
  it('returns one chunk for a single paragraph', () => {
    expect(chunkByParagraph('Hello world')).toEqual([{ text: 'Hello world', range: { start: 0, end: 11 } }])
  })

  it('splits on blank lines and keeps absolute offsets', () => {
    const text = 'First.\n\nSecond.\n\n\nThird.'
    const chunks = chunkByParagraph(text)
    expect(chunks.map((c) => c.text)).toEqual(['First.', 'Second.', 'Third.'])
    for (const c of chunks) expect(text.slice(c.range.start, c.range.end)).toBe(c.text)
  })

  it('drops whitespace-only paragraphs', () => {
    expect(chunkByParagraph('\n\n  \n\nA')).toEqual([{ text: 'A', range: { start: 6, end: 7 } }])
  })
})
