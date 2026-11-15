"""align.py without a model: text prep, windows, wildcard placement, assembly, LRC."""
from krobi_helper.align import (
    LOW_CONFIDENCE,
    Line,
    Owner,
    Word,
    assemble,
    build_targets,
    drop_strays,
    frame_count,
    HOP,
    prepare_text,
    romanize,
    spell_number,
    stamp,
    to_lrc,
    windows,
)

DICT = {"-": 0, "a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "o": 6, "s": 7, "u": 8, "n": 9, "t": 10, "r": 11, "*": 99}


# ------------------------------------------------------------------ text


def test_digits_are_spelled_the_way_they_are_sung():
    assert spell_number(12, "es") == "doce"
    assert spell_number(45, "es") == "cuarenta y cinco"
    assert spell_number(1999, "es") == "mil novecientos noventa y nueve"
    assert spell_number(12, "en") == "twelve"
    assert spell_number(1_000_000) == "1000000"
    assert romanize("Te dieron un beso a las 12", "es") == "te dieron un beso a las doce"


def test_labels_are_dropped_and_blank_lines_mark_stanzas():
    lines = prepare_text("[Coro]\nUno dos\n\nTres\nVerse 2:\n(x2)\nCuatro\n")
    assert [line.text for line in lines] == ["Uno dos", "Tres", "Cuatro"]
    assert [line.stanza_start for line in lines] == [True, True, True]
    assert [line.stanza_start for line in prepare_text("a\nb\n\nc")] == [True, False, True]


def test_a_token_keeps_its_spelling_and_may_spell_several_words():
    (line,) = prepare_text("¡Canción 12 — l'été!")
    assert line.text == "¡Canción 12 — l'été!"
    assert line.tokens == [("¡Canción", ["cancion"]), ("12", ["doce"]), ("—", []), ("l'été!", ["l'ete"])]
    assert line.words == ["cancion", "doce", "l'ete"]


def test_a_line_with_no_latin_letters_is_not_aligned():
    assert [line.text for line in prepare_text("Uno\n漢字だけ\nDos")] == ["Uno", "Dos"]


# --------------------------------------------------------------- windows


def test_windows_tile_the_song_exactly_with_context_around():
    spans = windows(35 * 16000, 16000, window_s=10, context_s=3)
    assert [(k0, k1) for _, _, k0, k1 in spans] == [(0, 160000), (160000, 320000), (320000, 480000), (480000, 560000)]
    lo, hi, _, _ = spans[1]
    assert (lo, hi) == (160000 - 48000, 320000 + 48000)
    assert spans[0][0] == 0 and spans[-1][1] == 560000  # context clipped at the edges
    assert windows(0) == []


def test_a_shifted_tiling_puts_its_edges_inside_the_first_ones_windows():
    n = 35 * 16000
    plain = {k1 for _, _, _, k1 in windows(n, 16000, 10, 3)}
    shifted = windows(n, 16000, 10, 3, offset_s=5)
    assert [(k0, k1) for _, _, k0, k1 in shifted][:2] == [(0, 80000), (80000, 240000)]
    assert shifted[-1][3] == n
    assert not ({k1 for _, _, _, k1 in shifted} - {n}) & plain


def test_every_bound_is_a_whole_hop_so_frames_do_not_drift():
    for lo, _hi, k0, _k1 in windows(100 * 16000 + 7, 16000, 8, 3, offset_s=4):
        assert lo % HOP == 0 and k0 % HOP == 0
    assert frame_count(16000) == 49 and frame_count(10) == 1


# ------------------------------------------------------------- wildcards


def _lines():
    return prepare_text("ab\ncd\n\nes")


def _stars(targets):
    return [i for i, t in enumerate(targets) if t == 99]


def test_wildcard_per_line_before_each_line():
    targets, owners = build_targets(_lines(), DICT, 99, "line")
    assert targets == [99, 1, 2, 99, 3, 4, 99, 5, 7]
    assert owners[1] == Owner(0, 0) and owners[0] is None


def test_wildcard_per_stanza_at_breaks_and_both_ends():
    targets, _ = build_targets(_lines(), DICT, 99, "stanza")
    assert targets == [99, 1, 2, 3, 4, 99, 5, 7, 99]


def test_wildcard_edges_and_none():
    assert _stars(build_targets(_lines(), DICT, 99, "edges")[0]) == [0, 7]
    assert _stars(build_targets(_lines(), DICT, 99, "none")[0]) == []


def test_characters_outside_the_dictionary_and_the_blank_are_skipped():
    (line,) = prepare_text("a-b x")
    targets, _ = build_targets([line], DICT, 99, "none")
    assert targets == [1, 2]  # "-" is the blank, "x" is not in this dictionary


# -------------------------------------------------------------- assembly


def test_assemble_times_words_flags_low_lines_and_carries_punctuation():
    lines = prepare_text("ab —\ncd")
    targets, owners = build_targets(lines, DICT, 99, "line")
    probs = {1: 0.9, 2: 0.7, 3: 0.1, 4: 0.1}
    frames = {1: 10, 2: 12, 3: 50, 4: 52}
    spans = [(frames.get(t, i), frames.get(t, i) + 1, probs.get(t, 1.0)) for i, t in enumerate(targets)]
    out = assemble(lines, spans, owners, 0.02)
    assert [(line.text, line.start) for line in out] == [("ab —", 0.2), ("cd", 1.0)]
    assert out[0].words[0].text == "ab —"  # the dash rides on the word before it
    assert out[0].conf == 0.8 and not out[0].low
    assert out[1].conf == 0.1 and out[1].low and out[1].conf < LOW_CONFIDENCE


def test_a_stray_first_letter_far_before_its_word_does_not_set_the_time():
    chars = [(10, 11, 0.0), (450, 452, 0.5), (453, 455, 0.6)]
    assert drop_strays(chars, 50) == chars[1:]
    assert drop_strays(chars, 0) == chars
    lines = prepare_text("ab")
    targets, owners = build_targets(lines, DICT, 99, "none")
    out = assemble(lines, [(10, 11, 0.0), (450, 452, 0.5)], owners, 0.02, max_char_gap_s=1.0)
    assert out[0].start == 9.0


def test_lead_is_applied_only_when_asked_and_never_below_zero():
    lines = prepare_text("ab")
    _, owners = build_targets(lines, DICT, 99, "none")
    spans = [(10, 11, 0.5), (12, 13, 0.5)]
    assert assemble(lines, spans, owners, 0.02)[0].start == 0.2
    assert assemble(lines, spans, owners, 0.02, lead_s=0.5)[0].start == 0.0


# ------------------------------------------------------------------- lrc


def test_lrc_is_line_level_sorted_and_word_tags_are_opt_in():
    lines = [
        Line("Dos", 65.5, 66.0, 0.9, False, [Word("Dos", 65.5, 66.0, 0.9)]),
        Line("Uno uno", 3.25, 4.0, 0.9, False, [Word("Uno", 3.25, 3.5, 0.9), Word("uno", 3.6, 4.0, 0.9)]),
    ]
    assert to_lrc(lines) == "[00:03.25] Uno uno\n[01:05.50] Dos\n"
    assert to_lrc(lines, word_tags=True).splitlines()[0] == "[00:03.25] <00:03.25> Uno <00:03.60> uno"


def test_a_stamp_never_reads_sixty_seconds():
    assert stamp(59.999) == "[01:00.00]"
    assert stamp(-1) == "[00:00.00]"


# ------------------------------------------------- the model step, stubbed


def test_align_samples_end_to_end_with_a_stub_model(monkeypatch):
    """No checkpoint: a fake acoustic model that 'hears' each character in a
    known frame. Exercises the inference-mode tensors, the star column write,
    forced alignment and assembly together — the one path a pure test misses."""
    torch = __import__("pytest").importorskip("torch")
    torchaudio = __import__("pytest").importorskip("torchaudio")
    import numpy as np

    from krobi_helper import align as A

    labels = torchaudio.pipelines.MMS_FA.get_dict(star="*")
    script = [(1.0, "uno"), (3.0, "dos")]  # word, second it is sung at

    class Stub(torch.nn.Module):
        def forward(self, x):
            n = A.frame_count(x.shape[1])
            em = torch.full((1, n, len(labels)), -20.0)
            em[0, :, 0] = 0.0  # blank everywhere…
            return em, None

    stub = Stub()

    def fake_emissions(samples, device, window_s, context_s, tilings=1):
        with torch.inference_mode():
            em = stub(torch.zeros(1, len(samples)))[0][0]
            for at, word in script:  # …except where each letter is sung
                for i, ch in enumerate(word):
                    f = int(at / 0.02) + 2 * i
                    em[f, 0] = -20.0
                    em[f, labels[ch]] = 0.0
            return em

    monkeypatch.setattr(A, "emissions", fake_emissions)
    result = A.align_samples(np.zeros(5 * 16000, dtype=np.float32), "Uno\nDos", device="cpu")
    assert [line.text for line in result.lines] == ["Uno", "Dos"]
    assert [round(line.start, 2) for line in result.lines] == [1.0, 3.0]
    assert result.low_lines == [] and all(line.conf > 0.9 for line in result.lines)
    assert A.to_lrc(result.lines) == "[00:01.00] Uno\n[00:03.00] Dos\n"


# --------------------------------------------------------------- viterbi


def _brute_best(logp, targets):
    """Every CTC path of ``targets`` through ``logp``, scored; the best score."""
    import itertools

    frames, vocab = len(logp), len(logp[0])
    best = None
    for path in itertools.product(range(vocab), repeat=frames):
        collapsed, prev = [], None
        for tok in path:
            if tok != prev and tok != 0:
                collapsed.append(tok)
            prev = tok
        if collapsed != list(targets):
            continue
        score = sum(logp[t][tok] for t, tok in enumerate(path))
        best = score if best is None else max(best, score)
    return best


def _score(logp, targets, spans):
    import numpy as np

    total = 0.0
    used = set()
    for tok, (a, b, _p) in zip(targets, spans, strict=True):
        for t in range(a, b):
            total += logp[t][tok]
            used.add(t)
    total += sum(logp[t][0] for t in range(len(logp)) if t not in used)
    return float(np.float32(total))


def test_viterbi_finds_the_optimum_where_torchaudio_did_not():
    from krobi_helper.align import viterbi

    logp = [[0.0, -20.0, -20.0] for _ in range(100)]  # blank, "u", wildcard
    logp[50] = [-20.0, 0.0, -1.0]
    for row in logp:
        row[2] = -1.0
    spans = viterbi(logp, [2, 1])
    assert spans[1][:2] == (50, 51)
    assert _score(logp, [2, 1], spans) == -1.0


def test_viterbi_matches_brute_force_on_small_random_cases():
    import random

    from krobi_helper.align import viterbi

    rng = random.Random(7)
    for _ in range(40):
        frames, vocab = rng.randint(3, 6), 4
        targets = [rng.randint(1, vocab - 1) for _ in range(rng.randint(1, 3))]
        logp = [[rng.uniform(-6, 0) for _ in range(vocab)] for _ in range(frames)]
        best = _brute_best(logp, targets)
        if best is None:
            continue
        spans = viterbi(logp, targets)
        assert len(spans) == len(targets)
        assert all(a < b for a, b, _ in spans) and all(s[1] <= n[0] for s, n in zip(spans, spans[1:], strict=False))
        assert abs(_score(logp, targets, spans) - best) < 1e-3


def test_viterbi_needs_a_blank_between_repeats_and_refuses_too_little_audio():
    import pytest

    from krobi_helper.align import AlignError, viterbi

    spans = viterbi([[0.0, 0.0]] * 3, [1, 1])
    assert spans[0][1] < spans[1][0]  # a blank frame separates the two "1"
    with pytest.raises(AlignError):
        viterbi([[0.0, 0.0]] * 2, [1, 1])
