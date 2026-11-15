"""Full-resolution artwork URLs shared by acquisition sources."""
import re

# Deezer serves images from a path that carries the size verbatim:
#   https://cdn-images.dzcdn.net/images/cover/<hash>/500x500-000000-80-0-0.jpg
# so one variant can be derived from another with no second API call. Anchored
# on a `dzcdn.net` host so a rewrite can never move a URL to a different origin.
_DEEZER_IMAGE_RE = re.compile(
    r"^(?P<prefix>https://[A-Za-z0-9.\-]+\.dzcdn\.net/images/[a-z]+/[A-Za-z0-9]+/)"
    r"\d+x\d+"
    r"(?P<suffix>-[0-9A-Za-z\-]*\.(?:jpg|jpeg|png))$"
)

#: The largest variant the Deezer API itself advertises (`cover_xl`,
#: `picture_xl`). The CDN also answers 200 for 1800x1800, but nothing documents
#: a master above 1000 px, and an upscale embedded permanently into a library
#: file is worse than an honest 1000 px cover.
FULL_IMAGE_SIDE = 1000


def full_size_image_url(url: str | None, side: int = FULL_IMAGE_SIDE) -> str | None:
    """Upgrade known Deezer cover URLs before embedding permanent artwork.

    Rewriting avoids an extra quota request and works with cached browse URLs.
    Return other hosts unchanged because their size conventions are unknown.
    """
    if not isinstance(url, str) or not url.strip():
        return url
    match = _DEEZER_IMAGE_RE.match(url.strip())
    if not match:
        return url
    return f"{match.group('prefix')}{side}x{side}{match.group('suffix')}"

