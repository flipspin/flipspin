"""The parts of the pipeline that need no model: romanization, LRC, hallucination filter."""
from krobi_helper.pipeline import alignable_lines, clean_segments, lines_from_transcription, romanize_line, to_lrc


def test_romanize_strips_diacritics_and_keeps_only_the_aligner_alphabet():
    assert romanize_line("Canción, ¡qué bonita! Tête brûlée — l'été") == "cancion que bonita tete brulee l'ete"
    assert alignable_lines("Uno\n\n漢字だけ\nDos") == [("Uno", "uno"), ("Dos", "dos")]


def test_lrc_stamps_are_sorted_and_zero_padded():
    assert to_lrc([(65.5, "b"), (3.25, "a")]) == "[00:03.25] a\n[01:05.50] b\n"


def _seg(text, start=0.0, no_speech=0.1, logprob=-0.3):
    return {"text": text, "start": start, "no_speech_prob": no_speech, "avg_logprob": logprob, "words": []}


def test_thank_you_on_a_loop_is_an_instrumental_not_a_lyric():
    result = {"segments": [_seg(" Thank you.", 0), _seg(" Thank you.", 30), _seg(" Thank you.", 63)]}
    assert lines_from_transcription(result) == []


def test_silence_and_low_confidence_segments_are_dropped_but_real_lines_stay():
    result = {"segments": [
        _seg(" Como la marea, baby", 5.0),
        _seg(" ghost words", 9.0, no_speech=0.9),
        _seg(" mumble", 12.0, logprob=-1.4),
        _seg(" Vamo' a bailar hasta tarde", 14.0),
    ]}
    assert [t for _, t in lines_from_transcription(result)] == ["Como la marea, baby", "Vamo' a bailar hasta tarde"]
    assert len(clean_segments(result)) == 2
