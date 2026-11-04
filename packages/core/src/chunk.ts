import type { TextRange } from './types.js'

export interface Chunk {
  text: string
  range: TextRange
}

const PARAGRAPH_SEPARATOR = /\n\s*\n/g

/**
 * Splits text into paragraphs so each can be checked and cached independently.
 * Ranges are absolute offsets into the original text.
 */
export function chunkByParagraph(text: string): Chunk[] {
  const chunks: Chunk[] = []
  let cursor = 0
  for (const match of text.matchAll(PARAGRAPH_SEPARATOR)) {
    pushChunk(text, cursor, match.index, chunks)
    cursor = match.index + match[0].length
  }
  pushChunk(text, cursor, text.length, chunks)
  return chunks
}

function pushChunk(text: string, start: number, end: number, out: Chunk[]): void {
  const slice = text.slice(start, end)
  const leading = slice.length - slice.trimStart().length
  const trailing = slice.length - slice.trimEnd().length
  const trimmedStart = start + leading
  const trimmedEnd = end - trailing
  if (trimmedEnd > trimmedStart) {
    out.push({ text: text.slice(trimmedStart, trimmedEnd), range: { start: trimmedStart, end: trimmedEnd } })
  }
}
