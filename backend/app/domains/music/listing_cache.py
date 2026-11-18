"""Bounded, scope-specific wire snapshots; conditional polls do no disk work."""
from collections import OrderedDict
import threading

from pydantic import TypeAdapter
from starlette.responses import Response

from app.domains.music.schemas import AlbumWithMetadata
from app.infra.idempotency import canonical

ALBUMS = TypeAdapter(list[AlbumWithMetadata])


class ListingCache:
    def __init__(self):
        self.lock = threading.Lock()
        self.revisions = None
        self.entries = OrderedDict()

    def invalidate(self):
        with self.lock:
            self.revisions = None
            self.entries.clear()

    def response(self, revisions, key, build):
        with self.lock:
            if self.revisions != revisions:
                self.entries.clear()
                self.revisions = revisions
            if key not in self.entries:
                body = ALBUMS.dump_python(ALBUMS.validate_python(build()), mode='json')
                self.entries[key] = canonical(body).encode()
                if len(self.entries) > 16:
                    self.entries.popitem(last=False)
            body = self.entries[key]
            self.entries.move_to_end(key)
        return Response(body, media_type='application/json')
