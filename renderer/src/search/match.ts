/** Shared library matcher. Prepare fields once per listing; tokenize once per query. */
export function foldSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function searchWords(query: string): string[] {
  return [...new Set(foldSearchText(query).trim().split(/\s+/).filter(Boolean))]
}

type Field = { text: string; words: string }
export type SearchDocument = { title: Field; album: Field; artist: Field }

function field(value: string): Field {
  const text = foldSearchText(value)
  return { text, words: `\0${text.replace(/[^\p{L}\p{N}]+/gu, '\0')}\0` }
}

export function prepareSearchDocument(song: { title?: string; album?: string; artist?: string }): SearchDocument {
  return { title: field(song.title || ''), album: field(song.album || ''), artist: field(song.artist || '') }
}

function fieldScore(field: Field, word: string): number {
  if (!field.text.includes(word)) return 0
  if (field.words.includes(`\0${word}\0`)) return 100
  return field.words.includes(`\0${word}`) ? 10 : 1
}

/** -1 means no match; 0 is the empty query. Every word may match a different field. */
export function scoreSearchDocument(document: SearchDocument, words: readonly string[]): number {
  let score = 0
  for (const word of words) {
    // Match tiers are 100/10/1; field weights are title 10, album 5, artist 3.
    const best = Math.max(fieldScore(document.title, word) * 10,
      fieldScore(document.album, word) * 5, fieldScore(document.artist, word) * 3)
    if (!best) return -1
    score += best
  }
  return score
}

/** Folded UTF-16 offsets mapped to whole original codepoints, including decomposed accents. */
export function matchRanges(text: string, query: string): [number, number][] {
  let folded = ''
  const starts: number[] = [], ends: number[] = []
  let offset = 0
  for (const char of text) {
    const part = foldSearchText(char)
    if (!part && ends.length) ends[ends.length - 1] = offset + char.length
    for (let i = 0; i < part.length; i++) {
      starts.push(offset)
      ends.push(offset + char.length)
    }
    folded += part
    offset += char.length
  }
  const ranges: [number, number][] = []
  for (const word of searchWords(query)) {
    let at = folded.indexOf(word)
    while (at !== -1) {
      ranges.push([starts[at], ends[at + word.length - 1]])
      at = folded.indexOf(word, at + 1)
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([...range])
  }
  return merged
}
