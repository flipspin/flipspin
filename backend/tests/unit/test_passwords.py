"""Password normalization, policy, stored hashes and verification cost.

Preserve independent salts, recorded parameters and dummy derivation.
Keep password policy independent of account storage.
See docs/security.md#password-hashing.
"""
import time

import pytest

from app.domains.accounts import passwords


CORRECT = "correct horse battery"
WRONG = "correct horse batteries"


class TestTheStoredValue:
    def test_a_hash_verifies_its_own_password(self):
        stored = passwords.hash_password(CORRECT)
        assert passwords.verify_password(CORRECT, stored) is True

    def test_a_hash_refuses_a_different_password(self):
        stored = passwords.hash_password(CORRECT)
        assert passwords.verify_password(WRONG, stored) is False

    def test_the_plaintext_is_nowhere_in_the_stored_value(self):
        """The point of a KDF: a stolen users.json yields nothing to read."""
        stored = passwords.hash_password(CORRECT)
        assert CORRECT not in stored
        assert "correct" not in stored.lower().split("$")[-1]

    def test_two_accounts_with_one_password_store_different_values(self):
        """Per-account salt. Identical stored values would tell whoever reads
        the file which members of the household share a password."""
        assert passwords.hash_password(CORRECT) != passwords.hash_password(CORRECT)

    def test_the_value_names_its_algorithm_and_its_parameters(self):
        stored = passwords.hash_password(CORRECT)
        algorithm, params, salt, key = stored.split("$")
        assert algorithm == "scrypt"
        assert params == f"n={passwords.SCRYPT_N},r={passwords.SCRYPT_R},p={passwords.SCRYPT_P}"
        assert salt and key

    def test_it_is_one_field_and_not_four(self):
        """A hash and the parameters that produced it are meaningless apart;
        one string cannot be half-written or half-migrated."""
        assert isinstance(passwords.hash_password(CORRECT), str)


class TestRaisingTheCostLater:
    def test_a_hash_written_at_the_current_cost_is_not_stale(self):
        assert passwords.needs_rehash(passwords.hash_password(CORRECT)) is False

    def test_a_hash_written_at_a_lower_cost_still_verifies(self, monkeypatch):
        """The requirement the stored parameters exist for: raising the floor
        must not log the whole household out."""
        monkeypatch.setattr(passwords, "SCRYPT_N", 1 << 12)
        cheap = passwords.hash_password(CORRECT)

        monkeypatch.undo()
        assert passwords.verify_password(CORRECT, cheap) is True

    def test_a_hash_written_at_a_lower_cost_reports_itself_stale(self, monkeypatch):
        monkeypatch.setattr(passwords, "SCRYPT_N", 1 << 12)
        cheap = passwords.hash_password(CORRECT)

        monkeypatch.undo()
        assert passwords.needs_rehash(cheap) is True

    def test_an_unreadable_value_is_stale_rather_than_kept(self):
        for junk in (None, "", "not-a-hash", "scrypt$n=oops$aa$bb", "scrypt$$$"):
            assert passwords.needs_rehash(junk) is True


class TestAMissCostsWhatAHitCosts:
    """The property ``POST /api/login`` depends on, and the one most likely to
    be optimised away by somebody being helpful.

    A ``verify_password`` that returned early for "there is no account" would
    answer in microseconds where a real check takes tens of milliseconds, and
    the difference is trivially measurable over a LAN: an attacker learns which
    usernames exist without guessing a single password.
    """

    @staticmethod
    def _elapsed(raw, stored):
        start = time.perf_counter()
        assert passwords.verify_password(raw, stored) is False
        return time.perf_counter() - start

    def test_verifying_against_nothing_still_answers_false(self):
        assert passwords.verify_password(CORRECT, None) is False

    def test_verifying_against_a_corrupt_value_still_answers_false(self):
        assert passwords.verify_password(CORRECT, "scrypt$n=8,r=1$!!$!!") is False

    def test_the_no_account_path_takes_as_long_as_the_wrong_password_path(self):
        """Both do exactly one derivation, so the ratio is ~1. The bound is
        loose because this runs on shared CI hardware; the failure it is aimed
        at is two orders of magnitude, not twenty percent."""
        stored = passwords.hash_password(CORRECT)
        # One warm-up each: the first scrypt call in a process pays for lazily
        # loaded OpenSSL state, and it would land on whichever case ran first.
        self._elapsed(WRONG, stored)
        self._elapsed(CORRECT, None)

        real = min(self._elapsed(WRONG, stored) for _ in range(3))
        missing = min(self._elapsed(CORRECT, None) for _ in range(3))

        assert missing > real / 3, "a fast miss is a username oracle"

    def test_an_empty_password_against_no_account_still_does_the_work(self):
        """The cheapest possible probe an attacker can send must not be cheap
        for the server to answer."""
        assert self._elapsed("", None) > 0.001


class TestTheFloor:
    def test_a_password_at_the_floor_is_accepted(self):
        assert passwords.validate_password("a" * passwords.MIN_PASSWORD_LENGTH)

    def test_a_password_below_the_floor_is_refused(self):
        with pytest.raises(passwords.PasswordPolicyError):
            passwords.validate_password("a" * (passwords.MIN_PASSWORD_LENGTH - 1))

    def test_the_message_never_quotes_the_password_back(self):
        """It is on its way into an HTTP body and possibly a log."""
        with pytest.raises(passwords.PasswordPolicyError) as excinfo:
            passwords.validate_password("hunter2")
        assert "hunter2" not in str(excinfo.value)

    def test_there_are_no_composition_rules(self):
        """Deliberate. A checklist produces ``Password1!``; length produces a
        phrase somebody can actually remember."""
        for phrase in (
            "todos los caballos",
            "aaaaaaaaaaaaaaaaaa",
            "1234567890123456789",
            "..........",
        ):
            assert passwords.validate_password(phrase)

    def test_an_absurdly_long_password_is_refused(self):
        """The KDF runs on whatever arrives and the login route is public."""
        with pytest.raises(passwords.PasswordPolicyError):
            passwords.validate_password("a" * (passwords.MAX_PASSWORD_LENGTH + 1))

    def test_length_is_counted_in_characters_not_bytes(self):
        """Ten accented characters are ten characters, whatever UTF-8 makes of
        them; counting bytes would quietly make the floor easier for some
        alphabets and harder for others."""
        assert passwords.validate_password("ñ" * passwords.MIN_PASSWORD_LENGTH)


class TestNormalization:
    def test_the_same_phrase_typed_two_ways_verifies(self):
        """Composed and decomposed accents are different bytes and the same
        password. A phone and a laptop must not disagree about it."""
        composed = "contraseña segura"
        decomposed = "contraseña segura"
        assert composed != decomposed

        stored = passwords.hash_password(composed)
        assert passwords.verify_password(decomposed, stored) is True

    def test_leading_and_trailing_spaces_are_part_of_the_password(self):
        """Unlike a username. Trimming would silently break a password that
        worked the day before the trimming was added."""
        stored = passwords.hash_password(" spaced out ")
        assert passwords.verify_password(" spaced out ", stored) is True
        assert passwords.verify_password("spaced out", stored) is False

    def test_case_is_not_folded(self):
        stored = passwords.hash_password("Correct Horse")
        assert passwords.verify_password("correct horse", stored) is False


class TestTheStoredValueIsReadDefensively:
    """Malformed password storage blocks password sign-in without invalidating devices
    or preventing startup."""

    @pytest.mark.parametrize(
        "junk",
        [
            "",
            "plaintext",
            "scrypt$n=32768,r=8,p=1$onlythree",
            "scrypt$n=32768,r=8,p=1$@@@@$@@@@",
            "some-other-kdf$n=1$aa$bb",
            "scrypt$n=0,r=8,p=1$YWJj$YWJj",
            "scrypt$n=32767,r=8,p=1$YWJj$YWJj",  # not a power of two
        ],
    )
    def test_junk_verifies_nothing_and_raises_nothing(self, junk):
        assert passwords.verify_password(CORRECT, junk) is False

    def test_an_implausibly_expensive_parameter_set_is_refused_not_attempted(self):
        """``n = 2**30`` would try to allocate a terabyte before failing. A
        parameter set read off disk is exactly where one would come from."""
        started = time.perf_counter()
        assert passwords.verify_password(CORRECT, "scrypt$n=1073741824,r=8,p=1$YWJj$YWJj") is False
        # Still derive at the server's fixed cost, never at caller-supplied parameters.
        assert time.perf_counter() - started < 5
