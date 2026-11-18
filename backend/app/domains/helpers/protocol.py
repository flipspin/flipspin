"""Helper upload envelope shared by the stems service and HTTP aliases."""
STEMS = ("drums", "bass", "vocals", "other")
MANIFEST_NAME = "song.json"
STEM_SUFFIX = ".ogg"


class StemsManifestError(ValueError):
    """A split manifest cannot be served."""
