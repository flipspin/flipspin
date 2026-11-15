import { isActive, type AcquisitionItem, type AcquisitionRequest, type CatalogTrack } from './api';

const stages = ['request', 'match', 'fetch', 'import', 'link'];
export function isPublished(item?: AcquisitionItem) {
  return item?.state === 'done' && (['import', 'link'].includes(item.stage)
    || (item.stage === 'match' && ['on-nido', 'shared-fetch'].includes(item.detail?.reason)));
}

/** Stage idx is local; detail.index refers to the submitted manifest. Never use
 * SQL result order or a title alone to choose between stages/duplicate songs. */
export function trackProgress(request: AcquisitionRequest | null | undefined, tracks: CatalogTrack[]) {
  return tracks.map((track, position) => {
    const manifest = request?.tracks;
    let index: number;
    if (manifest) {
      const candidates = manifest.map((entry, i) => ({ entry, i })).filter(({ entry }) =>
        track.ref?.id && entry.provider_id ? String(entry.provider_id) === String(track.ref.id)
          : entry.title === track.title && (!entry.artist || entry.artist === track.artistName)
            && (!entry.album || entry.album === track.albumTitle)
            && (!entry.track_number || entry.track_number === track.trackPosition));
      const positioned = candidates.filter(({ entry }) => track.trackPosition != null && entry.track_number === track.trackPosition);
      index = candidates.length === 1 ? candidates[0].i : positioned.length === 1 ? positioned[0].i : -1;
    } else {
      // Compatibility with older servers: use the full request's indexed title,
      // or a unique title for a subset. Ambiguous titles cannot identify a row.
      const submitted = request?.items?.filter(item => item.stage === 'request') || [];
      const candidates = submitted.filter(item => item.item === track.title);
      index = request?.expected_tracks === tracks.length && candidates.some(item => item.detail?.index === position)
        ? position : candidates.length === 1 ? candidates[0].detail.index : -1;
    }
    const items = index >= 0 ? (request?.items || []).filter(item => item.detail?.index === index) : [];
    const ordered = [...items].sort((a, b) => stages.indexOf(b.stage) - stages.indexOf(a.stage));
    const failed = ordered.find(item => item.state === 'failed');
    const current = ordered[0];
    // Later stages are allocated up front. Their queued placeholders must not
    // hide a running fetch or send fetched audio back to the queue.
    const running = ordered.find(item => item.state === 'running');
    const fetched = ordered.find(item => item.state === 'done' && ['fetch', 'import', 'link'].includes(item.stage));
    const matched = ordered.find(item => item.stage === 'match' && item.state === 'done');
    const item = failed || running || fetched || matched || current;
    const published = !failed && (items.some(item => item.stage === 'link')
      ? items.some(item => item.stage === 'link' && item.state === 'done') : items.some(isPublished));
    const key = items.find(item => item.stage === 'link' && item.state === 'done')?.detail?.rel_path;
    return { item, published, key, index };
  });
}

/** An independent song request cannot take another row's collection receipt. */
export function requestTrackProgress(requests: Record<string, AcquisitionRequest>, tracks: CatalogTrack[], retainedIds = new Set<string>()) {
  const ledgers = Object.values(requests).reverse().map(request => ({ request, progress: trackProgress(request, tracks) }));
  return tracks.map((_track, index) => {
    const owns = ({ progress }) => progress[index].index >= 0;
    const owner = ledgers.find(entry => isActive(entry.request) && owns(entry)) || ledgers.find(owns);
    return { ...(owner?.progress[index] || { index: -1, item: undefined, key: undefined, published: false }),
      requestId: owner?.request.id,
      current: !!owner && (isActive(owner.request) || retainedIds.has(owner.request.id)) };
  });
}
