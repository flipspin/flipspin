# Decoder fixtures

Synthetic 440 Hz tones, generated locally with ffmpeg (no external recordings).
The short fixtures exercise priming and non-packet-aligned ends; the four-second
fixtures exercise bisection, preroll and resampling after seeks. Tests need no
encoder or network access.

- `tone.m4a`: 44.1 kHz stereo AAC-LC, 4410 source frames, six packets;
  tail moov, edit-list media time 1024.
- `tone.flac`: 44.1 kHz mono, 4410 source frames.
- `tone.opus`: 48 kHz mono, 4800 source frames, 312 pre-skip frames.
- `tone.ogg`: 44.1 kHz stereo, 4410 input frames; ffmpeg's experimental Vorbis
  encoder records 4416 in the end granule. The decoder must honor that granule.
- `seek.flac`: 96 kHz / 24-bit mono, four seconds, no SEEKTABLE.
- `seek.opus`: 48 kHz mono, four seconds, 64 kbit/s.
- `seek.ogg`: 44.1 kHz stereo, four seconds, experimental Vorbis encoder.

Commands (run in a temporary directory; copy only the resulting fixtures):

```sh
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=44100:duration=0.1 -ac 2 -c:a aac -b:a 128k tone.m4a
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=44100:duration=0.1 -c:a flac tone.flac
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=0.1 -c:a libopus tone.opus
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=44100:duration=0.1 -ac 2 -c:a vorbis -strict -2 tone.ogg
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=96000:duration=4 -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 seek.flac
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=4 -c:a libopus -b:a 64k seek.opus
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=44100:duration=4 -ac 2 -c:a vorbis -strict -2 seek.ogg
```
