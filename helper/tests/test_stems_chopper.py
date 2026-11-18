"""The stems chopper on a synthetic song: no model, numpy only.

70 s at 120 BPM in 4/4 → a beat every 0.5 s, a bar every 2 s, 35 bars.
drums: a decaying noise click on every beat (louder on the downbeat);
bass: 55 Hz only in bars 4–29; other: a sustained chord; vocals: 1.5 s
"phrases" every 4 s with silence between. A faint 1 kHz bed under every
stem guarantees zero crossings everywhere, like real audio.
"""
import numpy as np
import pytest

from krobi_helper import stems as S

SR = 44100
DUR = 70.0
BEAT = 0.5
BAR = 2.0


def _t():
    return np.arange(int(DUR * SR)) / SR


@pytest.fixture(scope="module")
def song():
    t = _t()
    rng = np.random.default_rng(7)
    bed = 0.001 * np.sin(2 * np.pi * 1000 * t)
    beats = [round(b, 4) for b in np.arange(0.0, DUR, BEAT)]
    downbeats = [round(b, 4) for b in np.arange(0.0, DUR, BAR)]

    drums = bed.copy()
    click_len = int(0.08 * SR)
    env = np.exp(-np.arange(click_len) / (0.01 * SR))
    for i, b in enumerate(beats):
        start = int(b * SR) + int(0.01 * SR)  # the hit lands 10 ms after the grid
        amp = 0.9 if i % 4 == 0 else 0.3 + 0.1 * (i % 3)
        seg = slice(start, min(len(t), start + click_len))
        n = seg.stop - seg.start
        drums[seg] += amp * env[:n] * rng.uniform(-1, 1, n)

    bass = bed.copy()
    on = (t >= 4 * BAR) & (t < 30 * BAR)
    bass[on] += 0.5 * np.sin(2 * np.pi * 55 * t[on])

    other = bed + 0.2 * (np.sin(2 * np.pi * 440 * t) + np.sin(2 * np.pi * 523.25 * t) + np.sin(2 * np.pi * 659.25 * t))

    vocals = bed.copy()
    phrase_starts = np.arange(1.0, DUR - 2, 4.0)
    for s in phrase_starts:
        seg = (t >= s) & (t < s + 1.5)
        vocals[seg] += 0.6 * np.sin(2 * np.pi * 300 * t[seg])

    sources = {
        "drums": drums.astype(np.float32),
        "bass": bass.astype(np.float32),
        "other": other.astype(np.float32),
        "vocals": vocals.astype(np.float32),
    }
    mix = sum(sources.values()).astype(np.float32)
    return {"mix": mix, "sources": sources, "beats": beats, "downbeats": downbeats, "phrases": phrase_starts}


def _is_zero_crossing(x, t):
    k = int(round(t * SR))
    k = min(max(k, 1), len(x) - 2)
    a, b, c = np.signbit(x[k - 1]), np.signbit(x[k]), np.signbit(x[k + 1])
    return a != b or b != c


def _check_common(chops, signal, expect=16):
    assert len(chops) == expect
    starts = [c["start"] for c in chops]
    assert starts == sorted(starts), "chops are in time order"
    for c in chops:
        assert 0.0 <= c["start"] < c["end"] <= DUR
        assert c["end"] - c["start"] >= S.MIN_CHOP_S
        assert _is_zero_crossing(signal, c["start"]), c
        assert _is_zero_crossing(signal, c["end"]), c


def test_snap_finds_the_nearest_sign_change_on_a_sine():
    t = np.arange(SR) / SR
    x = np.sin(2 * np.pi * 100 * t).astype(np.float32)  # crossings every 5 ms
    snapped = S.snap_to_zero_crossing(x, SR, 0.0123)
    assert abs(snapped - 0.0100) < 1.5 / SR or abs(snapped - 0.0150) < 1.5 / SR
    assert _is_zero_crossing(x, snapped)
    # Nothing to find in DC: the quietest sample within the window.
    ramp = np.linspace(1.0, 2.0, SR, dtype=np.float32)
    assert S.snap_to_zero_crossing(ramp, SR, 0.5) == pytest.approx(0.5 - S.ZC_WINDOW_S, abs=1.5 / SR)


def test_full_is_sixteen_equal_groups_of_bars(song):
    chops = S.chop_full(song["mix"], SR, DUR, song["beats"], song["downbeats"])
    _check_common(chops, song["mix"])
    # 35 bars → 2-bar phrases (the largest k with 16·k ≤ 35), spread over the song.
    assert chops[0]["label"] == "bars 1-2"
    assert all(c["label"].startswith("bars ") for c in chops)
    for c in chops:
        assert c["end"] - c["start"] == pytest.approx(2 * BAR, abs=0.02)


def test_drums_are_the_strongest_onsets_with_spacing(song):
    chops = S.chop_drums(song["sources"]["drums"], SR, DUR, song["beats"])
    _check_common(chops, song["sources"]["drums"])
    assert chops[0]["label"] == "hit 1" and chops[-1]["label"] == "hit 16"
    hits = np.array(song["beats"]) + 0.01
    for c in chops:
        # Each chop starts on a real hit (pre-roll + onset-frame resolution).
        assert np.min(np.abs(hits - c["start"])) < 0.03, c
        # The loudest hits are the downbeats.
        nearest = hits[np.argmin(np.abs(hits - c["start"]))]
        assert round((nearest - 0.01) / BEAT) % 4 == 0, c
        assert c["end"] - c["start"] <= BEAT + 0.01
    gaps = np.diff([c["start"] for c in chops])
    assert np.all(gaps >= max(1.0, 2 * BEAT) - 0.01)


def test_a_near_silent_drum_stem_gives_fewer_hits_not_noise(song):
    drums = song["sources"]["drums"].copy()
    t = _t()
    quiet = t > 10.0
    drums[quiet] *= 0.001  # after 10 s the kit drops 60 dB
    chops = S.chop_drums(drums, SR, DUR, song["beats"])
    assert 0 < len(chops) < 16
    assert all(c["start"] < 10.1 for c in chops)


def test_bass_sits_on_the_bar_grid_where_it_plays(song):
    chops = S.chop_grid(song["sources"]["bass"], SR, DUR, song["beats"], song["downbeats"])
    _check_common(chops, song["sources"]["bass"])
    for c in chops:
        assert 4 * BAR - 0.01 <= c["start"] and c["end"] <= 30 * BAR + 0.01
        assert c["end"] - c["start"] == pytest.approx(BAR, abs=0.01)
        assert c["label"].startswith("bar ")


def test_other_spreads_over_the_whole_song(song):
    chops = S.chop_grid(song["sources"]["other"], SR, DUR, song["beats"], song["downbeats"])
    _check_common(chops, song["sources"]["other"])
    assert chops[0]["start"] < 2 * BAR and chops[-1]["end"] > DUR - 2 * BAR


def test_vocals_are_phrases_snapped_to_beats(song):
    chops = S.chop_vocals(song["sources"]["vocals"], SR, DUR, song["beats"])
    expected = min(16, len(song["phrases"]))
    _check_common(chops, song["sources"]["vocals"], expect=expected)
    phrases = np.asarray(song["phrases"])
    for c in chops:
        s = phrases[np.argmin(np.abs(phrases - c["start"]))]
        assert c["start"] == pytest.approx(s, abs=0.01)
        assert c["end"] == pytest.approx(s + 1.5, abs=0.01)
        assert c["label"].startswith("phrase ")


def test_few_long_phrases_are_split_towards_sixteen():
    dur = 40.0
    t = np.arange(int(dur * SR)) / SR
    x = (0.001 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    for s in (2.0, 22.0):  # two 8-second phrases
        seg = (t >= s) & (t < s + 8.0)
        x[seg] += 0.6 * np.sin(2 * np.pi * 300 * t[seg]).astype(np.float32)
    beats = list(np.arange(0.0, dur, BEAT))
    chops = S.chop_vocals(x, SR, dur, beats, list(np.arange(0.0, dur, BAR)))
    assert len(chops) == 16
    assert all(2.0 - 0.01 <= c["start"] < c["end"] <= 30.01 for c in chops)


def test_build_chops_names_all_five_lists(song):
    chops = S.build_chops(song["mix"], song["sources"], SR, DUR, song["beats"], song["downbeats"])
    assert set(chops) == {"full", "drums", "bass", "other", "vocals"}
    assert all(len(v) <= 16 for v in chops.values())


def test_a_short_track_gives_fewer_than_sixteen():
    dur = 5.0
    t = np.arange(int(dur * SR)) / SR
    x = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    beats = list(np.arange(0.0, dur, BEAT))
    downbeats = list(np.arange(0.0, dur, BAR))
    full = S.chop_full(x, SR, dur, beats, downbeats)
    assert 0 < len(full) < 16
    assert all(0 <= c["start"] < c["end"] <= dur for c in full)
    # An instrumental's vocal stem: silence → no phrases, not an error.
    assert S.chop_vocals(np.zeros_like(x), SR, dur, beats) == []


def test_no_grid_falls_back_to_equal_slices():
    t = np.arange(int(20 * SR)) / SR
    x = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    chops = S.chop_full(x, SR, 20.0, [], [])
    assert len(chops) == 16 and chops[0]["label"] == "slice 1"


def test_bpm_and_key():
    assert S.estimate_bpm([0.0, 0.5, 1.0, 1.5, 2.0]) == 120.0
    assert S.estimate_bpm([]) is None
    t = np.arange(10 * SR) / SR
    # A C-major triad with the tonic loudest.
    x = (0.5 * np.sin(2 * np.pi * 261.63 * t) + 0.3 * np.sin(2 * np.pi * 329.63 * t) + 0.3 * np.sin(2 * np.pi * 392.0 * t))
    assert S.estimate_key(x.astype(np.float32), SR) == "C major"
