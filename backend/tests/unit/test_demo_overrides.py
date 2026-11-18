"""``shift_lrc``: the demo trim's lyric shift."""
from app.infra.demo_overrides import shift_lrc

LRC = (
    "[ar:Daft Punk]\n"
    "[00:15.16] Lock it, fill it\n"
    "[00:18.89] Surf it, scroll it\n"
    "[00:22.69] Name it, read it\n"
)


def test_the_line_the_cut_lands_in_starts_at_zero_and_earlier_ones_go():
    assert shift_lrc(LRC, -20.5) == (
        "[ar:Daft Punk]\n"
        "[00:00.00] Surf it, scroll it\n"
        "[00:02.19] Name it, read it\n"
    )


def test_a_cut_exactly_on_a_line_adds_nothing():
    assert shift_lrc(LRC, -18.89).splitlines()[1:] == [
        "[00:00.00] Surf it, scroll it",
        "[00:03.80] Name it, read it",
    ]


def test_a_positive_offset_moves_everything_later():
    assert shift_lrc("[00:01.00] a\n", 2) == "[00:03.00] a\n"


def test_zero_offset_is_the_identity():
    assert shift_lrc(LRC, 0) == LRC


def test_a_lyric_nudged_just_past_the_cut_does_not_flash_the_line_before():
    # First surviving line at 0.39 s: the dropped "Lock it" is not in the audio.
    assert shift_lrc(LRC, -18.5).splitlines()[1:] == [
        "[00:00.39] Surf it, scroll it",
        "[00:04.19] Name it, read it",
    ]
