# Acquired audio

New source downloads select
`bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio`. Fetching leaves the
source untouched in staging. Processing probes its codec and packages AAC as
m4a using `-map 0:a:0 -vn -c:a copy`. Only a non-AAC source is encoded, using
`-c:a aac -b:a 256k`. Existing library audio and uploads retain their formats.

Source plugins own acquisition tools and report packaged audio through SourcePort.

The sole import boundary probes the staged file and decodes its complete audio
stream to a null output. It rejects missing audio, decoding failures, and a
duration below 90% of the requested recording. An unknown expected duration
skips only the ratio check. Rejected bytes are removed and the item records
`kind: broken`; no library file or account reference is created. ffprobe is
resolved beside the configured ffmpeg, then on PATH.

Successful import items expose additive `detail.audio_format` fields:
`codec`, `bitrate_bps` (nullable when unavailable), `container`, `duration_s`,
plus `source_codec` and `transcoded` for new source downloads. The same object
is included in `DownloadResult.to_dict()` as `audio_format`. Codec, bitrate
and duration come from the file checked immediately before publication; a
256 kbps encoder target is never substituted for its measured bitrate.
Private staging receipts preserve conversion provenance across a restart.

Legacy `normalize=true` measures loudness and writes ReplayGain tags without
encoding the audio. Its format report adds `normalization: replaygain-only`,
or `replaygain-unavailable` if measurement failed. Effect and volume boost
options no longer alter acquired samples. MP4 metadata and `covr` artwork use
the shared tag writer, alongside its existing BPM, key and ReplayGain atoms.
