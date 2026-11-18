"""The shared URL policy also applies to alternate user-input endpoints."""
import pytest
from pydantic import ValidationError

from app.domains.downloads.routes import RetryDownloadRequest
from app.domains.metadata.routes import AlbumUrlRequest
from app.domains.playlists.routes import ExportTrackRef


@pytest.mark.parametrize('model,fields', [
    (RetryDownloadRequest, {'progress_id': 'job', 'index': 0, 'youtube_url': 'https://user:secret@youtube.com/watch?v=x'}),
    (AlbumUrlRequest, {'url': 'file:///etc/passwd'}),
    (ExportTrackRef, {'title': 'Song', 'coverUrl': '--exec=echo injected'}),
])
def test_alternate_url_entry_points_reject_unsafe_inputs(model, fields):
    with pytest.raises(ValidationError):
        model(**fields)
