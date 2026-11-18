#!/bin/sh
# Map PUID/PGID and state ownership before dropping privileges.
# Never chown the music library: large shared collections keep host ownership.
# An explicit --user skips root setup. Preserve EX_CONFIG (78) so operators
# can distinguish refused state from a transient startup failure.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
MUSIC="${KROBI_MUSIC_DIR:-/music}"

if [ "$(id -u)" != "0" ]; then
    exec "$@"
fi

case "$PUID$PGID" in
    *[!0-9]*) echo "krobi: PUID and PGID must be numbers (got PUID=$PUID PGID=$PGID)" >&2; exit 64 ;;
esac

if [ "$(id -g krobi)" != "$PGID" ]; then
    groupmod -o -g "$PGID" krobi
fi
if [ "$(id -u krobi)" != "$PUID" ]; then
    usermod -o -u "$PUID" krobi
fi

mkdir -p /data/Krobi "$MUSIC"

# Correct state ownership only where it differs, pruning the music mount.
# Older layouts keep music under /data/Krobi/Music; it must retain host ownership.
find /data -path "$MUSIC" -prune -o \( ! -user "$PUID" -o ! -group "$PGID" \) \
    -exec chown -h "$PUID:$PGID" {} +

if ! setpriv --reuid="$PUID" --regid="$PGID" --clear-groups test -w "$MUSIC"; then
    echo "krobi: WARNING: $MUSIC is not writable by $PUID:$PGID." >&2
    echo "krobi:   Playback works; downloads, tag edits and deletes will fail." >&2
    echo "krobi:   Set PUID/PGID to the owner of the music folder on the host (ls -n)." >&2
fi

exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
