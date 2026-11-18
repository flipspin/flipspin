"""One-release ids for saved preferences and direct-download folders."""
LEGACY_SOURCE_ID = 'youtube'
LEGACY_SOURCES = {LEGACY_SOURCE_ID: ('YouTube', 'KROBI_SOURCE_LOCATION_YOUTUBE')}


def downloads_folder(source):
    return "YouTube Downloads" if source.id == LEGACY_SOURCE_ID else f"{source.manifest['name']} Downloads"
