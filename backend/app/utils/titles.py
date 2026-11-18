"""Song-title clean-up shared by the downloads and metadata domains.

For search strings and filenames only — it strips every parenthetical
lyrics marker and all punctuation. Never use it as a recording identity:
``domains/metadata/normalization.py`` explains why (it would merge the studio
and the live take of every song).
"""
import re


def clean_title(title: str) -> str:
    """Remove lyric markers and invalid filename characters from a song title.

    This display/filename cleanup is not recording-identity normalization.
    """
    # Remove "(lyrics)", "lyrics", etc.
    title = re.sub(r'\s*\(?lyrics.*?\)?\s*', '', title, flags=re.IGNORECASE).strip()
    # Remove characters that are not letters, numbers, spaces or hyphens
    title = re.sub(r"[^\w\s-]", "", title)
    # Replace multiple spaces with single space
    title = re.sub(r"\s+", " ", title)
    return title.strip()
