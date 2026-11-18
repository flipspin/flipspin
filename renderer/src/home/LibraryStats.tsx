import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, FolderOpen, Play } from "lucide-react";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { buildAlbumCoverUrl } from "@lib/api";
import { usePlayHistory } from "@lib/playHistory";
import { msg } from "../i18n";
import { openSettings } from "../shell/ServerBadge";
import { decorate, type DecoratedTrack, type ListedAlbum } from "./decorateTrack";
import { bpmBuckets, camelotNeighbours, decadeBuckets, fullest, genreBuckets, harmonicSongs, keyBuckets, librarySongs, listeningBuckets, moodBuckets, type SongBucket } from "./libraryStories";
import CoverTile from "../ui/components/CoverTile";
import "../ui/primitives.css";
import "./library-stories.css";
import { MoodEstimate } from "../analysis/MoodEstimate";

const CARDS = [msg("Tempo"), msg("Key_tone"), msg("Mood_mood"), msg("Decades"), msg("Genres"), msg("Listening")];
/** A dot's place on the ring, seen from the card on show: 0 is it, ±1 its neighbours, … (the shorter way round). */
export function ringOffset(index: number, current: number, count: number) {
  const d = (((index - current) % count) + count) % count;
  return d > count / 2 ? d - count : d;
}
const HUES = ["teal", "purple", "yellow", "blue", "green", "rose"];
const NAME_A = [msg("A♭ minor"), msg("E♭ minor"), msg("B♭ minor"), msg("F minor"), msg("C minor"), msg("G minor"), msg("D minor"), msg("A minor"), msg("E minor"), msg("B minor"), msg("F♯ minor"), msg("D♭ minor")];
const NAME_B = [msg("B major"), msg("F♯ major"), msg("D♭ major"), msg("A♭ major"), msg("E♭ major"), msg("B♭ major"), msg("F major"), msg("C major"), msg("G major"), msg("D major"), msg("A major"), msg("E major")];
const MOOD_NAMES: Record<string, string> = {
  upbeat: msg("upbeat"), animado: msg("upbeat"), groovy: msg("groovy"), calm: msg("calm"), calmo: msg("calm"),
  melancholic: msg("melancholic"), "melancólico": msg("melancholic"), aggressive: msg("aggressive"), agresivo: msg("aggressive"),
  romantic: msg("romantic"), "romántico": msg("romantic"), dark: msg("dark"), oscuro: msg("dark"), ambient: msg("ambient"),
};
type Vars = CSSProperties & Record<`--${string}`, string>;
type PlayerApi = { play: (track: DecoratedTrack, opts: { replaceQueue: boolean; upcomingTracks: DecoratedTrack[] }) => void };

function keyName(code: string): string {
  return (code.endsWith("A") ? NAME_A : NAME_B)[Number(code.slice(0, -1)) - 1] ?? "";
}

/** Radial bars in the approved canvas's single 260 × 260 coordinate system. */
function petalPath(code: string, count: number, max: number): string {
  const n = Number(code.slice(0, -1));
  const r1 = code.endsWith("A") ? 30 : 84;
  const r2 = r1 + Math.max(6, count / max * 40);
  const a0 = (n - .42) * Math.PI / 6;
  const a1 = (n + .42) * Math.PI / 6;
  const point = (r: number, a: number) => `${(130 + r * Math.sin(a)).toFixed(1)} ${(130 - r * Math.cos(a)).toFixed(1)}`;
  return `M ${point(r1, a0)} L ${point(r2, a0)} A ${r2} ${r2} 0 0 1 ${point(r2, a1)} L ${point(r1, a1)} A ${r1} ${r1} 0 0 0 ${point(r1, a0)} Z`;
}

export default function LibraryStats({ albums = [], loading = false, onOpenExplore }: {
  albums?: ListedAlbum[]; loading?: boolean; onOpenExplore?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { play } = useAudioPlayer() as unknown as PlayerApi;
  const history = usePlayHistory();
  const headingId = useId();
  const [card, setCard] = useState(0);
  const [picks, setPicks] = useState<Record<number, string>>({});
  const data = useMemo(() => {
    const songs = librarySongs(albums);
    return { songs, tempo: bpmBuckets(songs), keys: keyBuckets(songs), moods: moodBuckets(songs),
      decades: decadeBuckets(songs), genres: genreBuckets(songs), listening: listeningBuckets(songs, history) };
  }, [albums, history]);
  const buckets = [data.tempo, data.keys, data.moods, data.decades.buckets, data.genres.buckets.slice(0, 5), data.listening.buckets.slice(0, 5)][card];
  const selected = buckets.find(b => b.id === picks[card]) ?? buckets.find(b => b.id === (card === 5 ? buckets[0]?.id : fullest(buckets)));
  const pick = (id: string) => setPicks(prev => ({ ...prev, [card]: id }));
  const selectedSongs = card === 1 ? harmonicSongs(data.songs, selected?.id ?? "") : selected?.songs ?? [];
  const number = (n: number) => loading ? t("…") : n.toLocaleString(i18n.language);
  const songCount = (n: number) => loading ? t("…") : t("{{n}} songs", { count: n, n: number(n) });
  const percent = (n: number, total: number) => loading ? t("…") : t("{{n}}%", { n: number(total ? Math.round(n / total * 100) : 0) });
  const moodName = (id: string) => t(MOOD_NAMES[id] ?? id);
  const empty = !loading && data.songs.length === 0;
  const noKeys = !loading && card === 1 && !data.keys.some(b => b.songs.length);
  const noPlays = !loading && card === 5 && !data.listening.plays;
  const noMetadata = !loading && !empty && !noKeys && !noPlays && !buckets.some(b => b.songs.length);
  const none = empty || noKeys || noPlays || noMetadata;
  const neighbours = camelotNeighbours(selected?.id ?? "");
  const listening = data.listening.buckets.find(b => b.id === selected?.id);
  const songsWithMood = data.moods.reduce((n, b) => n + b.songs.length, 0);
  const knownYears = data.songs.length - data.decades.missing;
  const knownGenres = data.songs.length - data.genres.missing;

  // A tempo range ("120–130"): thin spaces around the dash, which the hero's
  // tight tracking otherwise ran into the digits.
  let claim = card === 0 && selected?.id ? selected.id.replace("–", "\u2009–\u2009") : selected?.id ?? t("No data");
  let word = t("BPM");
  let fact = songCount(selected?.songs.length ?? 0);
  if (card === 1) {
    word = t(keyName(selected?.id ?? ""));
    fact = t("{{songs}} · mix with {{keys}}", { songs: fact, keys: neighbours.join(" ") });
  } else if (card === 2) {
    claim = percent(selected?.songs.length ?? 0, songsWithMood);
    word = moodName(selected?.id ?? "");
  } else if (card === 3) {
    claim = t("{{decade}}s", { decade: selected?.id ?? "" });
    word = percent(selected?.songs.length ?? 0, knownYears);
    if (data.decades.missing) fact = t("{{songs}} · {{n}} without a year", { songs: fact, n: number(data.decades.missing) });
  } else if (card === 4) {
    claim = percent(selected?.songs.length ?? 0, knownGenres);
    word = selected?.id ?? t("No genre");
    if (data.genres.missing) fact = t("{{songs}} · {{n}} without a genre", { songs: fact, n: number(data.genres.missing) });
  } else if (card === 5) {
    claim = t("≈ {{n}} h", { n: number(Math.round(data.listening.hours)) });
    word = t("on this device");
    fact = t("{{n}} plays", { count: data.listening.plays, n: number(data.listening.plays) });
  }
  const go = (delta: number) => setCard(prev => (prev + delta + CARDS.length) % CARDS.length);
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    // Native button activation must not also toggle the shell's Space shortcut.
    if (event.key === " ") event.stopPropagation();
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault(); event.stopPropagation(); go(event.key === "ArrowRight" ? 1 : -1);
    }
  };
  const playSelected = () => {
    if (loading || !selectedSongs.length) return;
    const tracks = selectedSongs.map(s => decorate(s.track, s.album));
    play(tracks[0], { replaceQueue: true, upcomingTracks: tracks.slice(1) });
  };
  const max = Math.max(1, ...buckets.map(b => card === 5 ? data.listening.buckets.find(a => a.id === b.id)?.plays ?? 0 : b.songs.length));
  const barLabel = (b: SongBucket) => card === 0 ? t("{{range}} BPM · {{songs}}", { range: b.id, songs: songCount(b.songs.length) })
    : t("{{decade}}s · {{songs}}", { decade: b.id, songs: songCount(b.songs.length) });
  const dots = data.songs.filter(s => s.bpm !== null && s.energy !== null);

  const total = t("{{songs}} · {{hours}} h", {
    songs: songCount(data.songs.length), hours: number(Math.round(data.songs.reduce((n, s) => n + s.duration, 0) / 3600)),
  });
  const hue = empty ? "var(--paper)" : `var(--accent-${HUES[card]})`;
  // One frame (canvas "integrar las cartas", option 3): a cream body like the
  // other panels, the card's hue only in its figure, its kicker, the active
  // dot and the play disc; the arrows and dots live beside the kicker.
  return <section className={`krobi-library tb${empty ? " tb--empty" : ""}`} style={{ "--_c": hue } as Vars} aria-labelledby={headingId} aria-busy={loading} onKeyDown={keyboard}>
    <div className="tb-body">
      <article className={`z-story${card === 1 && !none ? " z-story--side" : ""}`} aria-label={t(CARDS[card])}>
        <div className="z-story__top">
          <h3 id={headingId} className="z-story__kicker" title={empty ? t("Your library") : `${t("Your library")} · ${t(CARDS[card])}`}>{t("Your library")}{!empty && <> · {t(CARDS[card])}</>}</h3>
          {!empty && <span className="tb-pager" title={total}>
            <button type="button" className="tb-arrow" aria-label={t("Previous card")} onClick={() => go(-1)}><ChevronLeft aria-hidden="true" /></button>
            <nav className="z-story-dots" aria-label={t("Cards")}>
              {CARDS.map((label, index) => <button key={label} type="button" aria-label={t(label)} title={t(label)} data-d={ringOffset(index, card, CARDS.length)}
                aria-current={card === index ? "true" : undefined} aria-pressed={card === index}
                onFocus={() => setCard(index)} onClick={() => setCard(index)} />)}
            </nav>
            <button type="button" className="tb-arrow" aria-label={t("Next card")} onClick={() => go(1)}><ChevronRight aria-hidden="true" /></button>
          </span>}
          {empty && <span className="tb-total">{total}</span>}
        </div>
        {card === 1 && !loading ? <div className="z-story__fact" role="status">{t("{{n}} of {{total}} songs", { n: number(data.songs.filter(song => song.camelot !== null).length), total: number(data.songs.length) })}{data.songs.some(song => song.camelot === null) ? ` · ${t("{{n}} not analyzed", { n: number(data.songs.filter(song => song.camelot === null).length) })}` : ''}</div> : null}
        {none ? <div className="tb-none">
          {empty && <FolderOpen size={42} aria-hidden="true" />}
          <b>{empty ? t("No songs yet") : noKeys ? t("No keys detected") : noPlays ? t("Nothing played here") : t("No analysis data")}</b>
          <span className="z-mono">{noKeys ? t("0 of {{n}} songs", { count: data.songs.length, n: number(data.songs.length) }) : noPlays ? t("0 plays on this device")
            : card === 3 ? t("{{n}} without a year", { n: number(data.decades.missing) }) : card === 4 ? t("{{n}} without a genre", { n: number(data.genres.missing) }) : songCount(data.songs.length)}</span>
          {empty && <button type="button" className="tb-empty-action" onClick={onOpenExplore}>{t("Open Explore")}</button>}
          {noKeys && <button type="button" className="tb-empty-action" onClick={() => openSettings("analisis")}>{t("Detect keys")}</button>}
        </div> : <>
          <div className="tb-claim" aria-live="polite" aria-atomic="true">
            <div className="tb-claim-line">
              <div className="z-story__big" title={card === 5 ? t("Σ plays × duration ÷ 3600; this device only") : undefined}>{loading ? t("…") : claim}</div>
              <button type="button" className="tb-play" disabled={loading || !selectedSongs.length} onClick={playSelected}
                title={t("Play {{n}}", { n: number(selectedSongs.length) })} aria-label={t("Play {{n}}", { n: number(selectedSongs.length) })}>
                <Play size={14} fill="currentColor" aria-hidden="true" />
              </button>
            </div>
            <div className="z-story__word">{loading && [3].includes(card) ? t("…") : card === 2 && selected?.id ? <MoodEstimate>{word}</MoodEstimate> : word}</div>
            <div className="z-story__fact">{loading ? t("…") : fact}</div>
          </div>
          <div className="z-story__fig">
            {(card === 0 || card === 3) && <>
              <div className="z-pickbars" role="group" aria-label={t(CARDS[card])}>
                {buckets.map(b => <button type="button" key={b.id} aria-pressed={selected?.id === b.id} title={barLabel(b)} aria-label={barLabel(b)} onClick={() => pick(b.id)} disabled={loading}>
                  <i style={{ "--_h": `${loading ? 12 : b.songs.length ? Math.max(5, b.songs.length / max * 100) : 1}%` } as Vars} />
                </button>)}
              </div>
              <div className="z-pickbars__ticks" aria-hidden="true">{buckets.map((b, i) => <span key={b.id}>{loading ? t("…") : card === 0 ? i % 3 === 0 ? 60 + i * 10 : "" : t("{{decade}}s", { decade: b.id.slice(-2) })}</span>)}</div>
            </>}
            {card === 1 && <svg className="z-bloom" viewBox="0 0 260 260" role="group" aria-label={t("Songs by key, Camelot wheel")}>
              <circle className="z-bloom__ring" cx="130" cy="130" r="30" /><circle className="z-bloom__ring" cx="130" cy="130" r="84" />
              {data.keys.map(b => {
                const path = petalPath(b.id, loading ? max * .15 : b.songs.length, max);
                const label = t("{{key}} · {{name}} · {{songs}}", { key: b.id, name: t(keyName(b.id)), songs: songCount(b.songs.length) });
                return <path key={b.id} d={path} tabIndex={0} role="button" aria-label={label}
                  aria-pressed={selected?.id === b.id} aria-disabled={loading}
                  data-near={neighbours.includes(b.id) ? "" : undefined}
                  onClick={() => { if (!loading) pick(b.id); }}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault(); event.stopPropagation();
                      if (!loading) pick(b.id);
                    }
                  }}><title>{label}</title></path>;
              })}
              {Array.from({ length: 12 }, (_, i) => <text key={i} x={130 + 77 * Math.sin((i + 1) * Math.PI / 6)} y={130 - 77 * Math.cos((i + 1) * Math.PI / 6)}>{loading ? t("…") : i + 1}</text>)}
              <text x="130" y="130">{t("A·B")}</text>
            </svg>}
            {card === 2 && <>
              <svg className="z-dotmap" viewBox="0 0 360 170" role="img" aria-label={t("Tempo by energy")}>
                {dots.map(s => <circle key={s.track.path} cx={8 + Math.min(1, Math.max(0, (s.bpm - 60) / 130)) * 344} cy={162 - s.energy * 154} r={s.mood === selected?.id ? 5.5 : 4} data-on={s.mood === selected?.id ? "" : undefined} />)}
              </svg>
              {!dots.length && !loading && <span className="tb-map-note">{t("No tempo and energy detected")}</span>}
              <ChipScroller label={t("Moods")}>{data.moods.map(b => <button key={b.id} type="button" aria-pressed={selected?.id === b.id} title={songCount(b.songs.length)} onClick={() => pick(b.id)} disabled={loading}>{moodName(b.id)}</button>)}</ChipScroller>
            </>}
            {card === 5 && selected?.id === data.listening.buckets[0]?.id && listening && <div className="tb-mosaic" aria-label={t("Albums by {{artist}}", { artist: listening.id || t("Unknown artist") })}>
              {listening.albums.slice(0, 4).map((album, i) => <CoverTile key={album.path ?? i} src={buildAlbumCoverUrl(album)} label={album.album || album.name || t("Album")} fontSize="18px" />)}
            </div>}
            {(card === 4 || card === 5) && <div className="z-pickrows" role="group" aria-label={t(CARDS[card])}>
              {buckets.map(b => {
                const n = card === 5 ? data.listening.buckets.find(a => a.id === b.id)?.plays ?? 0 : b.songs.length;
                const label = b.id || t("Unknown artist");
                return <button key={b.id} type="button" aria-pressed={selected?.id === b.id} aria-label={t("{{name}} · {{detail}}", { name: label, detail: card === 5 ? t("{{n}} plays", { count: n, n: number(n) }) : songCount(n) })} title={label} onClick={() => pick(b.id)} disabled={loading} style={{ "--_w": `${n / max * 100}%` } as Vars}>
                  <span>{label}</span><span className="z-mono">{number(n)}</span>
                </button>;
              })}
            </div>}
          </div>
        </>}
      </article>
    </div>
  </section>;
}

/** The mood chips in one row, moved with bare ‹ › arrows; no scrollbar (WebKit's
 *  clipped the chips). Each arrow only shows while there is more on its side. */
function ChipScroller({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = () => {
    const el = row.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
  };
  const by = (dir: number) => row.current?.scrollBy({ left: dir * Math.max(80, (row.current?.clientWidth ?? 160) * 0.6), behavior: "smooth" });
  return <div className="tb-chips">
    {!edges.start && <button type="button" className="tb-chips__arrow" aria-label={t("Previous_plural")} onClick={() => by(-1)}><ChevronLeft aria-hidden="true" /></button>}
    <div ref={(el) => { row.current = el; if (el) requestAnimationFrame(measure); }} className="z-pickchips" role="group" aria-label={label} onScroll={measure}>{children}</div>
    {!edges.end && <button type="button" className="tb-chips__arrow" aria-label={t("Next_plural")} onClick={() => by(1)}><ChevronRight aria-hidden="true" /></button>}
  </div>;
}
