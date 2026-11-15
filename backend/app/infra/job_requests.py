"""Private, typed retry payloads kept inside items.detail (never sent to clients)."""
import base64
from dataclasses import asdict, is_dataclass
from pathlib import Path

from app.infra.jobs import Jobs
from app.infra.media_requests import TrackDownloadRequest, TrackMetadata, DownloadOptions


def encode_request(request):
    data = asdict(request)
    data['destination'] = str(request.destination)
    data['cover_data'] = base64.b64encode(request.cover_data).decode() if request.cover_data else None
    return data


def decode_request(data):
    data = dict(data)
    data['destination'] = Path(data['destination'])
    data['metadata'] = TrackMetadata(**data['metadata'])
    data['options'] = DownloadOptions(**data['options'])
    data['cover_data'] = base64.b64decode(data['cover_data']) if data.get('cover_data') else None
    return TrackDownloadRequest(**data)


def request_item(request):
    return {'item': request.metadata.title or request.search_query or request.youtube_url or 'Canción',
            'detail': {'_retry': {'producer': 'download', 'request': encode_request(request)}}}


def register_requests(tracker, job_id, requests):
    ledger = tracker.ledger
    if not ledger:
        return
    row = ledger.get(job_id)
    if not row or row['state'] not in ('queued', 'running') or row['attempt'] != tracker.attempt_for(job_id):
        return
    existing = ledger.items(job_id)
    # Preserve completed on-disk acquisitions and original indices on retry.
    if row['attempt'] == 1 or any(i['attempt'] == row['attempt'] and i['state'] in ('queued', 'running') and i['detail'].get('_retry', {}).get('producer') != 'download' for i in existing):
        available = [i for i in existing if i['state'] in ('queued', 'running')]
        updates = []
        used = set()
        for request in requests:
            data = request_item(request)
            match = next((i for i in available if i['idx'] not in used and i['item'] == data['item']), None)
            if match is None:
                match = next((i for i in available if i['idx'] not in used), None)
            idx = match['idx'] if match else max([i['idx'] for i in existing] + list(used), default=-1) + 1
            used.add(idx)
            updates.append({**data, 'idx': idx})
        ledger.configure(job_id, items=updates, attempt=tracker.attempt_for(job_id))
    if len(requests) == 1 and row['label'] in ('1 canciones', '1 canción'):
        metadata = requests[0].metadata
        ledger.configure(job_id, label=' · '.join(x for x in (metadata.title, metadata.artist) if x) or requests[0].search_query or requests[0].youtube_url)
    return existing


def record_call(tracker, job_id, method, *, after=None, **arguments):
    """Durably register an unresolved service call before scheduling its coroutine."""
    if not isinstance(getattr(tracker, "ledger", None), Jobs):
        return
    arguments = {k: str(v) if isinstance(v, Path) else asdict(v) if is_dataclass(v) else v for k,v in arguments.items()}
    existing = tracker.ledger.items(job_id)
    tracks = list(arguments.get('tracks', []))
    remaining = list(tracks)
    updates = []
    for item in existing or [{'item': tracker.ledger.get(job_id)['label']}]:
        if item.get('state') == 'done':
            continue
        args = dict(arguments)
        if tracks:
            track = next((t for t in remaining if t.get('name') == item['item']), None)
            if track is None:
                continue
            remaining.remove(track)
            args['tracks'] = [track]
        payload = {'_retry': {'producer': 'download-call', 'method': method, 'arguments': args}}
        if after:
            payload['_after'] = after
        updates.append({**item, 'detail': {**item.get('detail', {}), **payload}})
    tracker.ledger.configure(job_id, items=updates, attempt=tracker.attempt_for(job_id))
