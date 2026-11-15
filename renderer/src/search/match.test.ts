import { describe, expect, it } from 'vitest';
import { foldSearchText, matchRanges, prepareSearchDocument, scoreSearchDocument, searchWords } from './match';

const score = (song: Parameters<typeof prepareSearchDocument>[0], query: string) => scoreSearchDocument(prepareSearchDocument(song), searchWords(query));
describe('shared search matcher', () => {
  it('folds accents, case and ñ without changing the source', () => {
    expect(foldSearchText('Canción ÑANDÚ')).toBe('cancion nandu');
    expect(score({ title: 'Canción' }, 'cancion')).toBeGreaterThan(0);
    expect(score({ title: 'Niño' }, 'nino')).toBeGreaterThan(0);
    expect(score({ title: 'Canción' }, 'c')).toBeGreaterThan(0);
  });
  it('requires all words, across fields and in any order', () => {
    const song = { title: 'Levitating', album: 'Future Nostalgia', artist: 'Dua Lipa' };
    expect(score(song, 'dua future')).toBeGreaterThan(0);
    expect(score(song, 'lipa dua')).toBeGreaterThan(0);
    expect(score(song, 'dua missing')).toBe(-1);
    expect(searchWords('  DÚA  dua  future ')).toEqual(['dua', 'future']);
  });
  it('ranks exact words above prefixes above contains, then title > album > artist', () => {
    const rows = [{ title: 'Superfuture' }, { title: 'Futureproof' }, { title: 'Future' }];
    expect(rows.sort((a, b) => score(b, 'future') - score(a, 'future')).map(x => x.title)).toEqual(['Future', 'Futureproof', 'Superfuture']);
    expect(score({ title: 'Future' }, 'future')).toBeGreaterThan(score({ album: 'Future' }, 'future'));
    expect(score({ album: 'Future' }, 'future')).toBeGreaterThan(score({ artist: 'Future' }, 'future'));
    expect(score({ artist: 'Future' }, 'future')).toBeGreaterThan(score({ title: 'Futureproof' }, 'future'));
    expect(score({ artist: 'Futureproof' }, 'future')).toBeGreaterThan(score({ title: 'Superfuture' }, 'future'));
  });
  it('maps per-word highlights to original accents, decomposed marks, overlaps and surrogate pairs', () => {
    expect(matchRanges('Canción de Niño', 'nino cancion')).toEqual([[0, 7], [11, 15]]);
    expect(matchRanges('😀 Cancio\u0301n', 'cancion')).toEqual([[3, 11]]);
    expect(matchRanges('Canción', 'can cancion')).toEqual([[0, 7]]);
    expect(matchRanges('a.b a*b', 'a.b')).toEqual([[0, 3]]);
  });
  it('scans 100k prepared songs per query (150ms headroom for shared CI)', () => {
    const docs = Array.from({ length: 100_000 }, (_, i) => prepareSearchDocument({
      title: i % 100 === 0 ? `Canción ${i}` : `Track ${i}`, artist: i % 10 === 0 ? 'Dua Lipa' : 'Other Artist', album: 'Future Nostalgia',
    }));
    const timings: Record<string, number> = {};
    for (const query of ['cancion', 'dua future', 'lipa dua']) {
      const words = searchWords(query);
      const run = () => { let hits = 0; for (const doc of docs) if (scoreSearchDocument(doc, words) >= 0) hits++; return hits; };
      run(); // JIT warm-up is not query time.
      const samples = Array.from({ length: 5 }, () => { const start = performance.now(); expect(run()).toBeGreaterThan(0); return performance.now() - start; }).sort((a, b) => a - b);
      timings[query] = samples[2];
      expect(samples[2]).toBeLessThan(150);
    }
    console.info('100k prepared songs, median ms/query:', timings);
  });
});
