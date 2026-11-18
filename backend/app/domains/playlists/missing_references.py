"""Playlist positions preserved by missing-song removal and undo."""
from dataclasses import asdict
from pathlib import Path

from app.domains.playlists.models import PlaylistTrack
from app.utils.library_paths import rel_path_for


class PlaylistReferences:
    def __init__(self, repository, config):
        self.repository, self.config = repository, config

    def paths(self):
        return {rel for name in self.repository.list_playlists()
                for track in self.repository.load_playlist(name).tracks
                if (rel := rel_path_for(self.config.base_music_dir, track.path))}

    def snapshot(self, rel):
        return [{'name': name, 'position': i, 'track': {**asdict(track), 'path': str(track.path)}}
                for name in self.repository.list_playlists()
                for i, track in enumerate(self.repository.load_playlist(name).tracks)
                if rel_path_for(self.config.base_music_dir, track.path) == rel]

    def drop(self, rel, snapshot):
        for name in dict.fromkeys(item['name'] for item in snapshot):
            playlist = self.repository.load_playlist(name)
            playlist.tracks = [t for t in playlist.tracks if rel_path_for(self.config.base_music_dir, t.path) != rel]
            self.repository.save_playlist(playlist)

    def restore(self, rel, snapshot):
        appended = []
        for name in dict.fromkeys(item['name'] for item in snapshot):
            playlist = self.repository.load_playlist(name)
            if any(rel_path_for(self.config.base_music_dir, t.path) == rel for t in playlist.tracks):
                continue
            for item in [r for r in snapshot if r['name'] == name]:
                if item['position'] > len(playlist.tracks):
                    appended.append(name)
                playlist.tracks.insert(min(item['position'], len(playlist.tracks)),
                                      PlaylistTrack(**{**item['track'], 'path': Path(item['track']['path'])}))
            self.repository.save_playlist(playlist)
        return appended
