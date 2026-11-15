"""Utility functions for download domain - independent implementation."""
import re
import unicodedata

# Moved to app/utils/titles.py (metadata uses it too); re-exported for callers here.
from app.utils.titles import clean_title  # noqa: F401


def clean_filename(filename: str) -> str:
    """Remove invalid filesystem characters and traversal patterns from a filename."""
    # Remove invalid characters
    filename = re.sub(r'[\\/*?:"<>|]', '', filename)
    # Replace multiple dots with a single dot to prevent '..' traversal patterns
    filename = re.sub(r'\.{2,}', '.', filename)
    return filename


def strip_accents(text: str) -> str:
    """Fold accented characters for portable filenames."""
    if not text:
        return text
    
    # Normalize to NFD (decomposed form)
    nfd = unicodedata.normalize('NFD', text)
    # Filter out combining characters (accents)
    return ''.join(char for char in nfd if unicodedata.category(char) != 'Mn')


def sanitize_filename(filename: str, max_length: int = 255) -> str:
    """Sanitize a filename and bound its length for filesystem use."""
    # Remove invalid characters
    filename = clean_filename(filename)
    # Trim to max length
    if len(filename) > max_length:
        name, ext = filename.rsplit('.', 1) if '.' in filename else (filename, '')
        max_name_length = max_length - len(ext) - 1 if ext else max_length
        filename = f"{name[:max_name_length]}.{ext}" if ext else name[:max_length]
    return filename
