"""The setup handoff shared by server announcements (contracts/setup-link.json)."""
from urllib.parse import urlsplit


def make_setup_link(address: str, code: str) -> str:
    """Build a link from the server address and its URL-safe setup code.

    The fragment keeps the code out of HTTP request URLs.
    """
    return f"krobi://{urlsplit(address).netloc}/setup#{code}"
