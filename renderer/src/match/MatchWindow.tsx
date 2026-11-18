import { poll as pollInterval, startPoll, waitForPoll } from '../data/poll'
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { announceLibraryChanged } from '@lib/libraryEvents';
import { apiDelete, apiGet, apiPost, useCurrentUser } from '../data';
import type { components } from '../api/generated/schema';
import { notify } from '../ui/notifications';
import { useOffline } from '../offline/useOffline';
import { useHeld } from '../ui/react/useHeld';
import PanelModal from '../ui/components/PanelModal';
import { closeMatch, useMatchScope, type MatchScope } from './matchStore';
import './match.css';

type View = components['schemas']['MatchView'];
type Candidate = components['schemas']['MatchCandidate'];
const terminal = (state: string) => !['queued', 'running'].includes(state);
const keyOf = (rel: string, field: string) => JSON.stringify([rel, field]);
const keysOf = (candidate: Candidate) => candidate.files.flatMap(file => Object.keys(file.fields).map(field => keyOf(file.relPath, field)));
const show = (value: unknown) => Array.isArray(value) ? value.join('; ') : String(value);

export function MatchHost() {
  const scope = useMatchScope();
  const held = useHeld(scope);
  const user = useCurrentUser();
  const offline = useOffline();
  return held && user.data?.isOwner ? <MatchWindow scope={held} open={!!scope && !offline} onClose={closeMatch} /> : null;
}

export default function MatchWindow({ scope, open = true, onClose }: { scope: MatchScope; open?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [view, setView] = useState<View | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState<'query' | 'link' | null>(null);
  const [text, setText] = useState('');
  const [request, setRequest] = useState<{ query?: string; link?: string }>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const job = useRef<string | null>(null);
  const alive = useRef(true);
  const labels: Record<string, string> = {
    title: t("Title"), artist: t("Artist"), album: t("Album"), albumArtist: t("Album artist"),
    year: t("Year"), genre: t("Genre"), trackNumber: t("Track number_full"), trackTotal: t("Track total"),
    discNumber: t("Disc number_full"), discTotal: t("Disc total"), isrc: 'ISRC',
    mbRecording: t("MusicBrainz recording ID"), mbRelease: t("MusicBrainz release ID"), mbReleaseGroup: t("MusicBrainz release group ID"),
  };
  const fail = (error: unknown) => error instanceof Error ? error.message : t("MusicBrainz search failed");
  const refresh = () => { announceLibraryChanged(); void client.invalidateQueries({ queryKey: ['library'] }); };

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let stopPoll = () => {};
    let currentJob: string | null = null;
    setView(null); setError(''); setSelected(null); setChecked(new Set());
    const poll = async () => {
      try {
        const response = await apiGet('/api/library/match/{jobId}', { params: { path: { jobId: currentJob! } } });
        if (stopped) return;
        // A song may share an already-running album lookup. Keep server candidate
        // indices intact, but only offer files in the scope this window opened.
        const includes = (rel: string) => scope.albumKey ? rel.startsWith(scope.albumKey + '/') : !!scope.relPaths?.includes(rel);
        const value = { ...response, candidates: response.candidates.map(candidate => ({ ...candidate, files: candidate.files.filter(file => includes(file.relPath)) })),
          errors: response.errors.filter(error => includes(error.relPath)) };
        setView(value);
        if (terminal(value.state)) {
          stopPoll();
          const strong = value.candidates.findIndex(candidate => candidate.band === 'strong' && candidate.files.length > 0);
          if (strong >= 0) { setSelected(strong); setChecked(new Set(keysOf(value.candidates[strong]))); }
        }
      } catch (error) { if (!stopped) setError(fail(error)); }
    };
    void apiPost('/api/library/match', { body: { ...(scope.albumKey ? { albumKey: scope.albumKey } : { relPaths: scope.relPaths }), ...request } })
      .then(value => {
        currentJob = value.jobId;
        if (stopped) { void apiDelete('/api/library/match/{jobId}', { params: { path: { jobId: value.jobId } } }).catch(() => {}); return; }
        job.current = value.jobId;
        stopPoll = startPoll(() => pollInterval('active', true, 1000), poll);
      }).catch(error => { if (!stopped) setError(fail(error)); });
    return () => { stopped = true; stopPoll(); };
    // The scope is a stable store snapshot; a new search creates a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, request, open]);

  const choose = (index: number) => {
    setSelected(index);
    setChecked(new Set(keysOf(view!.candidates[index])));
  };
  const candidate = selected === null ? null : view?.candidates[selected];
  const files = candidate?.files.filter(file => Object.keys(file.fields).some(field => checked.has(keyOf(file.relPath, field)))) || [];
  const count = candidate?.files.reduce((sum, file) => sum + Object.keys(file.fields).filter(field => checked.has(keyOf(file.relPath, field))).length, 0) || 0;
  const running = !view || !terminal(view.state);
  const close = () => {
    if (locked.current) return;
    if (job.current && running) void apiDelete('/api/library/match/{jobId}', { params: { path: { jobId: job.current } } }).catch(() => {});
    onClose();
  };
  const undo = async (editId: string) => {
    try {
      await apiPost('/api/library/edits/{editId}/undo', { params: { path: { editId } } });
      refresh();
      notify({ message: t("Undo requested") });
    } catch (error) { notify({ level: 'error', message: fail(error) }); }
  };
  const apply = async () => {
    if (!view || selected === null || !count || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const plan = await apiPost('/api/library/match/{jobId}/plan', { params: { path: { jobId: view.jobId } }, body: { rows: files.map(file => ({
        relPath: file.relPath, candidate: selected, fields: Object.keys(file.fields).filter(field => checked.has(keyOf(file.relPath, field))),
      })) } });
      const send = () => apiPost('/api/library/edits/{planId}/apply', { params: { path: { planId: plan.planId } }, body: { planHash: plan.planHash } });
      let result = await send();
      while (result.state === 'applying') {
        await waitForPoll(1000);
        result = await send();
      }
      if (result.state === 'interrupted') throw new Error(t("Apply interrupted"));
      refresh();
      notify({ level: result.failed ? 'warning' : 'success', sticky: true,
        message: t("{{count}} files updated", { count: result.applied }) + ` · ${t("{{count}} skipped_masculine", { count: result.skipped })}` + (result.failed ? ` · ${t("{{count}} failed", { count: result.failed })}` : ''),
        action: result.applied ? { label: t("Undo"), onSelect: () => { void undo(result.editId); } } : undefined,
      });
      onClose();
    } catch (error) { if (alive.current) setError(fail(error)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };

  return <PanelModal open={open} title={`${t("Match on MusicBrainz")}${scope.title ? ` · ${scope.title}` : ''}`} width="max-w-5xl" className="mb-match" onClose={close} dismissible={!busy}
    footer={<><span className="mb-match__count" role="status">{t("{{count}} changes", { count })} · {t("{{count}} files", { count: files.length })}</span>
      <button className="k-btn k-btn--text" disabled={busy} onClick={close}>{t("Keep as is")}</button>
      <button className="k-btn k-btn--text k-btn--text-primary" disabled={!count || busy || running} onClick={() => { void apply(); }}>{busy ? t("Applying…") : t("Apply {{count}} changes", { count })}</button></>}>
    <div className="mb-match__body">
      <aside className="mb-match__candidates" aria-label={t("Candidates")}>
        <h3>{t("Candidates")}</h3>
        {view?.candidates.map((item, index) => item.files.length > 0 && <button key={`${item.id}-${index}`} className={`mb-match__candidate ${selected === index ? 'is-selected' : ''}`} aria-pressed={selected === index} disabled={busy || running} onClick={() => choose(index)}>
          <strong>{item.title}</strong><small>{item.subtitle}</small>
          <span className="mb-match__band" data-band={item.band} title={item.reasons.join(' · ')}>{t(item.band === 'strong' ? "Strong match" : item.band === 'review' ? "Review_match" : "Weak")}</span>
        </button>)}
        {running && !error && <span role="status">{t("Searching…")}</span>}
        {view && !running && !view.candidates.some(item => item.files.length) && <span>{t("No matches")}</span>}
        <button className="mb-match__link" disabled={busy || running && !error} onClick={() => { setSearch('query'); setText(''); }}>{t("Search again_retry")}</button>
        <button className="mb-match__link" disabled={busy || running && !error} onClick={() => { setSearch('link'); setText(''); }}>{t("Paste a MusicBrainz link")}</button>
        {search && <form className="mb-match__search" onSubmit={event => { event.preventDefault(); if (!text.trim()) return; setRequest({ [search]: text.trim() }); setSearch(null); }}>
          <input autoFocus className="k-field" aria-label={t(search === 'query' ? "Search again_retry" : "Paste a MusicBrainz link")} type={search === 'link' ? 'url' : 'text'} required maxLength={search === 'link' ? 200 : 1000} value={text} onChange={event => setText(event.target.value)} />
          <button className="k-btn" type="submit">{t("Search")}</button>
        </form>}
      </aside>
      <div className="mb-match__diff">
        {error && <div role="alert">{error}</div>}
        {view?.errors.map(item => <div role="alert" key={item.relPath}>{item.relPath}: {t(item.reason === 'provider-busy' ? "MusicBrainz is busy" : "MusicBrainz is unavailable")}</div>)}
        {candidate ? <table><thead><tr><th><span className="sr-only">{t("Apply")}</span></th><th>{t("Field")}</th><th>{t("Now")}</th><th>{t("New_masculine")}</th></tr></thead>
          {candidate.files.map(file => <tbody key={file.relPath}><tr className="mb-match__file"><th colSpan={4}>{file.relPath}</th></tr>
            {Object.entries(file.fields).map(([field, diff]) => <tr key={field}><td><input type="checkbox" disabled={busy} aria-label={`${t("Apply")} ${labels[field] || field} · ${file.relPath}`} checked={checked.has(keyOf(file.relPath, field))} onChange={event => setChecked(previous => { const next = new Set(previous); if (event.target.checked) next.add(keyOf(file.relPath, field)); else next.delete(keyOf(file.relPath, field)); return next; })} /></td>
              <th scope="row">{labels[field] || field}</th><td className="mb-match__now">{diff.now == null || diff.now === '' ? t("empty_masculine") : show(diff.now)}</td><td className="mb-match__new">{show(diff.new)}</td></tr>)}
            <tr className="mb-match__same"><td /><td>{t("{{count}} other fields", { count: file.same })}</td><td colSpan={2}>{t("same")}</td></tr>
          </tbody>)}
        </table> : !running && <span className="mb-match__empty">{t("Choose a candidate")}</span>}
      </div>
    </div>
  </PanelModal>;
}
