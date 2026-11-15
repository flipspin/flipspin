#!/bin/sh
# Linux installer. Prompts use /dev/tty so curl ... | sh keeps working.
set -eu

# Resolve only a plain stable release tag; no jq/Python dependency on the host.
resolve_release() {
    release_response=$(curl -fsSL --connect-timeout 3 --max-time 8 \
            -H 'Accept: application/vnd.github+json' \
            -A 'Flipspin/0.1.0-rc.15 ( https://github.com/flipspin/flipspin )' \
            https://api.github.com/repos/flipspin/flipspin/releases/latest 2>/dev/null) || release_response=''
    release_tag=$(printf '%s\n' "$release_response" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
    ) || release_tag=''
    case "$release_tag" in *'
'*) release_tag='' ;; esac
    if printf '%s\n' "$release_tag" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
        printf '%s\n' "${release_tag#v}"
    else
        printf '%s\n' 'Could not check the published release; using :latest.' >&2
        printf '%s\n' latest
    fi
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
# The original registry coordinates use the retained installer name.
canonical_image() {
    legacy_name=krobi
    case "$1" in
        "ghcr.io/$legacy_name-app/$legacy_name-server") printf '%s\n' ghcr.io/flipspin/flipspin-server ;;
        *) printf '%s\n' "$1" ;;
    esac
}
root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
log() { printf '%s\n' "$*"; printf '%s\n' "$*" | root tee -a /opt/krobi/install.log >/dev/null; }
# Dotenv values are literal single-quoted strings; never source them as shell.
get_env() { root sed -n "s/^$1='\(.*\)'$/\1/p" /opt/krobi/.env; }
valid_value() {
    cr=$(printf '\r')
    case "$1" in *"'"*|*"\\"*|*'
'*|*"$cr"*) fail 'Values cannot contain single quotes, backslashes or line breaks.' ;; esac
}
ask() {
    answer=
    if [ "$yes" != true ]; then
        ( : </dev/tty >/dev/tty ) 2>/dev/null || fail 'No terminal: use --yes and, if needed, --music, --data and --port.'
        printf '%s [%s]: ' "$1" "$2" >/dev/tty
        read -r answer </dev/tty || fail 'Could not read the answer.'
    fi
    answer=${answer:-$2}
}

# BEGIN GENERATED INSTALLER ENDING
# Regenerate with: python3 scripts/generate-installer-ending.py
ending_scene() {
    case "$1" in
        truecolor) cat <<'KROBI_SCENE_TRUECOLOR'
[0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m
[0m   [0;38;2;200;205;212m*[0m                              [0;38;2;200;205;212m*[0m
[0m   ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;2;122;160;240m⢸⡿⢶⣤⣀[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀                           [0;38;2;200;205;212m*[0m
[0m   ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;2;122;160;240m⢸⡇[0m⠀[0;38;2;122;160;240m⠈⢻⣧[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀          [0;38;2;110;118;129m░░░░░░[0m
[0m   ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;2;122;160;240m⣀⣀⣸⣇⣀⣀⠸⠟[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀   [0;38;2;200;205;212m*[0m   [0;38;2;110;118;129m░░░░░░░░░░░░[0m
[0m   ⠀⠀⠀⠀⠀⠀[0;38;2;122;160;240m⣀⣤⣶⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣤⣀[0m⠀⠀⠀⠀⠀⠀     [0;38;2;110;118;129m░░░░░░░░░░░░░░░░░░[0m
[0m [0;38;2;200;205;212m*[0m ⠀⠀⠀[0;38;2;122;160;240m⣀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣀[0m⠀⠀⠀                            [0;38;2;200;205;212m*[0m
[0m   ⠀[0;38;2;122;160;240m⢀⣼⣿⣿⣿⡿⠛⠉⠉⠉⠻⣿⣿⣿⣿⣿⣿⠟⠉⠉⠉⠛⢿⣿⣿⣿⣧⡀[0m⠀      [0;38;2;200;205;212m*[0m
[0m   ⠀[0;38;2;122;160;240m⣾⣿⣿⣿⠋[0m⠀⠀⠀⠀⠀⠀[0;38;2;122;160;240m⠘⣿⣿⣿⣿⠃[0m⠀⠀⠀⠀⠀⠀[0;38;2;122;160;240m⠙⣿⣿⣿⣷[0m⠀                [0;38;2;110;118;129m░░░░░░░[0m
[0m   [0;38;2;122;160;240m⣸⣿⣿⣿⠃[0m⠀⠀[0;38;2;122;160;240m⢀⣴⣤[0m⠀⠀⠀[0;38;2;122;160;240m⣿⣿⣿⣿[0m⠀⠀⠀[0;38;2;122;160;240m⣤⣦⡀[0m⠀⠀[0;38;2;122;160;240m⠘⣿⣿⣿⣇[0m             [0;38;2;110;118;129m░░░░░░░░░░░░░░░[0m
[0m   [0;38;2;122;160;240m⣿⣿⣿⠇[0m⠀⠀⠀[0;38;2;122;160;240m⠈⠛⠋[0m⠀⠀[0;38;2;239;126;85m⢶⣿⣿⣿⣿⡶[0m⠀⠀[0;38;2;122;160;240m⠙⠛⠁[0m⠀⠀⠀[0;38;2;122;160;240m⠸⣿⣿⣿[0m
[0m   [0;38;2;122;160;240m⣿⣿⣿⡀[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;2;239;126;85m⠉⠻⠟⠉[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;2;122;160;240m⢀⣿⣿⣿[0m         [0;38;2;200;205;212m*[0m
[0m   [0;38;2;122;160;240m⠈⠿⣿⣷⣀[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;2;122;160;240m⣀⣾⣿⠿⠁[0m                         [0;38;2;200;205;212m*[0m
[0m   ⠀⠀[0;38;2;122;160;240m⠈⠙⠻⠿⠶⣦⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣴⠶⠿⠟⠋⠁[0m
[0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m [0;38;2;110;118;129m·[0m
KROBI_SCENE_TRUECOLOR
            ;;
        256) cat <<'KROBI_SCENE_256'
[0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m
[0m   [0;38;5;251m*[0m                              [0;38;5;251m*[0m
[0m   ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;5;111m⢸⡿⢶⣤⣀[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀                           [0;38;5;251m*[0m
[0m   ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;5;111m⢸⡇[0m⠀[0;38;5;111m⠈⢻⣧[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀          [0;38;5;244m░░░░░░[0m
[0m   ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;5;111m⣀⣀⣸⣇⣀⣀⠸⠟[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀   [0;38;5;251m*[0m   [0;38;5;244m░░░░░░░░░░░░[0m
[0m   ⠀⠀⠀⠀⠀⠀[0;38;5;111m⣀⣤⣶⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣤⣀[0m⠀⠀⠀⠀⠀⠀     [0;38;5;244m░░░░░░░░░░░░░░░░░░[0m
[0m [0;38;5;251m*[0m ⠀⠀⠀[0;38;5;111m⣀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣀[0m⠀⠀⠀                            [0;38;5;251m*[0m
[0m   ⠀[0;38;5;111m⢀⣼⣿⣿⣿⡿⠛⠉⠉⠉⠻⣿⣿⣿⣿⣿⣿⠟⠉⠉⠉⠛⢿⣿⣿⣿⣧⡀[0m⠀      [0;38;5;251m*[0m
[0m   ⠀[0;38;5;111m⣾⣿⣿⣿⠋[0m⠀⠀⠀⠀⠀⠀[0;38;5;111m⠘⣿⣿⣿⣿⠃[0m⠀⠀⠀⠀⠀⠀[0;38;5;111m⠙⣿⣿⣿⣷[0m⠀                [0;38;5;244m░░░░░░░[0m
[0m   [0;38;5;111m⣸⣿⣿⣿⠃[0m⠀⠀[0;38;5;111m⢀⣴⣤[0m⠀⠀⠀[0;38;5;111m⣿⣿⣿⣿[0m⠀⠀⠀[0;38;5;111m⣤⣦⡀[0m⠀⠀[0;38;5;111m⠘⣿⣿⣿⣇[0m             [0;38;5;244m░░░░░░░░░░░░░░░[0m
[0m   [0;38;5;111m⣿⣿⣿⠇[0m⠀⠀⠀[0;38;5;111m⠈⠛⠋[0m⠀⠀[0;38;5;209m⢶⣿⣿⣿⣿⡶[0m⠀⠀[0;38;5;111m⠙⠛⠁[0m⠀⠀⠀[0;38;5;111m⠸⣿⣿⣿[0m
[0m   [0;38;5;111m⣿⣿⣿⡀[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;5;209m⠉⠻⠟⠉[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;5;111m⢀⣿⣿⣿[0m         [0;38;5;251m*[0m
[0m   [0;38;5;111m⠈⠿⣿⣷⣀[0m⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[0;38;5;111m⣀⣾⣿⠿⠁[0m                         [0;38;5;251m*[0m
[0m   ⠀⠀[0;38;5;111m⠈⠙⠻⠿⠶⣦⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣴⠶⠿⠟⠋⠁[0m
[0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m [0;38;5;244m·[0m
KROBI_SCENE_256
            ;;
        plain) cat <<'KROBI_SCENE_PLAIN'
· · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · ·
   *                              *
   ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡿⢶⣤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀                           *
   ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⠈⢻⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀          ░░░░░░
   ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣸⣇⣀⣀⠸⠟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀   *   ░░░░░░░░░░░░
   ⠀⠀⠀⠀⠀⠀⣀⣤⣶⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣤⣀⠀⠀⠀⠀⠀⠀     ░░░░░░░░░░░░░░░░░░
 * ⠀⠀⠀⣀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣀⠀⠀⠀                            *
   ⠀⢀⣼⣿⣿⣿⡿⠛⠉⠉⠉⠻⣿⣿⣿⣿⣿⣿⠟⠉⠉⠉⠛⢿⣿⣿⣿⣧⡀⠀      *
   ⠀⣾⣿⣿⣿⠋⠀⠀⠀⠀⠀⠀⠘⣿⣿⣿⣿⠃⠀⠀⠀⠀⠀⠀⠙⣿⣿⣿⣷⠀                ░░░░░░░
   ⣸⣿⣿⣿⠃⠀⠀⢀⣴⣤⠀⠀⠀⣿⣿⣿⣿⠀⠀⠀⣤⣦⡀⠀⠀⠘⣿⣿⣿⣇             ░░░░░░░░░░░░░░░
   ⣿⣿⣿⠇⠀⠀⠀⠈⠛⠋⠀⠀⢶⣿⣿⣿⣿⡶⠀⠀⠙⠛⠁⠀⠀⠀⠸⣿⣿⣿
   ⣿⣿⣿⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠻⠟⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣿⣿⣿         *
   ⠈⠿⣿⣷⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣾⣿⠿⠁                         *
   ⠀⠀⠈⠙⠻⠿⠶⣦⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣴⠶⠿⠟⠋⠁
· · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · ·
KROBI_SCENE_PLAIN
            ;;
    esac
}
# Arguments: running version, HTTP address, setup link, setup code (empty if claimed).
# stdout decides colour even when stdin is the curl pipe. Never call log() here.
print_ending() {
    ending_bold='' ending_dim='' ending_reset='' ending_art=plain
    if [ -t 1 ] && [ "${NO_COLOR+x}" != x ]; then
        ending_bold=$(printf '\033[1m')
        ending_dim=$(printf '\033[2m')
        ending_reset=$(printf '\033[0m')
        case "${COLORTERM:-}" in truecolor|24bit) ending_art=truecolor ;; *) ending_art=256 ;; esac
    fi
    # POSIX locale precedence: an explicit C locale overrides a UTF-8 LANG.
    case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
        *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) printf '\n'; ending_scene "$ending_art" ;;
    esac
    printf '\n%sFlipspin is running%s %s· %s%s\n\n' "$ending_bold" "$ending_reset" "$ending_dim" "$1" "$ending_reset"
    if [ -n "$4" ]; then
        printf '%s%s%s\n' "$ending_bold" "$3" "$ending_reset"
        printf '%sPaste it in Flipspin → Setup link%s\n' "$ending_dim" "$ending_reset"
        printf '%sNest address: %s\nSetup code: %s%s\n' "$ending_dim" "$2" "$4" "$ending_reset"
    else
        printf '%s%s%s\n' "$ending_bold" "$2" "$ending_reset"
        printf '%sAlready set up%s\n' "$ending_dim" "$ending_reset"
    fi
}
# END GENERATED INSTALLER ENDING

main() {
    yes=false music='' data='' port=''
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --yes) yes=true; shift ;;
            --music|--data|--port)
                [ "$#" -ge 2 ] && [ -n "$2" ] || fail "Missing value for $1."
                case "$1" in --music) music=$2 ;; --data) data=$2 ;; --port) port=$2 ;; esac
                shift 2 ;;
            --help) printf 'Usage: install.sh [--yes] [--music /path] [--data /path] [--port 8000]\n'; exit 0 ;;
            *) fail "Unknown option: $1" ;;
        esac
    done
    [ "$(uname -s)" = Linux ] || fail 'This installer requires Linux.'
    case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) fail 'Linux amd64 or arm64 is required (64-bit Raspberry Pi OS).' ;; esac
    command -v curl >/dev/null 2>&1 || fail 'Install curl first: sudo apt-get install curl ca-certificates'
    if [ "$(id -u)" != 0 ]; then
        command -v sudo >/dev/null 2>&1 || fail 'Run as root or install sudo.'
        sudo -v || fail 'Sudo access is required.'
    fi
    root install -d -m 0755 /opt/krobi
    root touch /opt/krobi/install.log
    root chmod 600 /opt/krobi/install.log
    log 'Flipspin installer (Linux amd64/arm64).'
    if ! command -v docker >/dev/null 2>&1; then
        # Do not replace an Engine installed without its CLI, or containerd/runc.
        if [ -d /var/lib/docker ] || [ -d /etc/docker ] || [ -S /var/run/docker.sock ] || command -v dockerd >/dev/null 2>&1 || command -v containerd >/dev/null 2>&1 || command -v runc >/dev/null 2>&1; then
            fail 'An existing container installation was found. Install Docker CLI and the Compose plugin manually; Docker has not been changed.'
        fi
        log 'Docker Engine, Docker CLI, containerd, Buildx and the Compose plugin will be installed from https://get.docker.com (official repository).'
        if [ "$yes" != true ]; then
            ask 'Install Docker? Type yes to accept' 'no'
            case "$answer" in yes|YES|sí|si|SI) ;; *) fail 'Docker installation cancelled.' ;; esac
        fi
        docker_installer=$(mktemp)
        curl -fsSL https://get.docker.com -o "$docker_installer"
        # The child shell expands its positional argument.
        # shellcheck disable=SC2016
        root sh -c 'sh "$1" >>/opt/krobi/install.log 2>&1' sh "$docker_installer" || { rm -f "$docker_installer"; fail 'The official Docker installation failed. Check your package manager.'; }
        rm -f "$docker_installer"
    fi
    root docker compose version >/dev/null 2>&1 || fail 'Docker is already installed but the Compose plugin is missing. Install it manually; Docker has not been changed.'
    root docker info >/dev/null 2>&1 || fail 'Docker is not responding. Start Docker (sudo systemctl start docker); on Proxmox LXC enable nesting=1.'
    log 'Docker and the Compose plugin are available; keeping the existing installation.'

    existing=false
    if root test -f /opt/krobi/.env; then
        root grep -q '^# Managed by krobi installer$' /opt/krobi/.env || fail '/opt/krobi/.env is not managed by this installer.'
        existing=true
    elif root test -f /opt/krobi/compose.yml; then
        fail '/opt/krobi/compose.yml already exists without installer configuration.'
    fi
    user_home=$HOME
    if [ -n "${SUDO_USER:-}" ]; then user_home=$(getent passwd "$SUDO_USER" | cut -d: -f6); fi
    default_music=/srv/krobi/music
    if [ -d "$user_home/Music" ]; then default_music=$user_home/Music; fi
    default_data=/srv/krobi/data default_port=8000
    if [ "$existing" = true ]; then
        default_music=$(get_env KROBI_MUSIC_DIR)
        default_data=$(get_env KROBI_DATA_DIR)
        default_port=$(get_env KROBI_PORT)
    fi
    if [ -z "$music" ]; then ask 'Music folder' "$default_music"; music=$answer; fi
    if [ -z "$data" ]; then ask 'Data folder' "$default_data"; data=$answer; fi
    port=${port:-$default_port}
    case "$port" in ''|*[!0-9]*|??????*) fail 'The port must be between 1 and 65535.' ;; esac
    [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail 'The port must be between 1 and 65535.'
    for path in "$music" "$data"; do
        valid_value "$path"
        case "$path" in /*) ;; *) fail 'Use absolute paths for music and data.' ;; esac
    done
    # Canonical paths make the purge checks meaningful (including symlinks/..).
    music=$(root realpath -m "$music") data=$(root realpath -m "$data")
    for path in "$music" "$data"; do
        valid_value "$path"
        case "$path" in /|/home|/srv|/var|/mnt|/media|/opt|/usr|/etc|/bin|/lib|/lib64|/sbin|/boot|/dev|/proc|/run|/sys|/tmp|/root|/var/lib|/var/log|/var/cache|/var/tmp|/etc/*|/usr/*|/bin/*|/sbin/*|/lib/*|/lib64/*|/boot/*|/dev/*|/proc/*|/run/*|/sys/*)
            fail "Choose a dedicated subfolder, not $path." ;;
            /home/*/*|/Users/*/*) ;;
            /home/*|/Users/*) fail "Choose a dedicated subfolder, not $path." ;;
        esac
    done
    case "$music/" in "$data/"*) fail 'Music must be outside the data folder.' ;; esac
    case "$data/" in "$music/"*) fail 'Data must be outside the music folder.' ;; esac
    case "$music/" in /opt/krobi/*) fail 'Music must be outside /opt/krobi.' ;; esac
    case "$data/" in /opt/krobi/*) fail 'Data must be outside /opt/krobi.' ;; esac
    if [ "$existing" = true ]; then
        [ "$music" = "$default_music" ] && [ "$data" = "$default_data" ] || fail 'This installation already has folders. Edit /opt/krobi/.env manually to migrate them.'
    fi
    music_created=false
    music_owned=0
    if ! root test -d "$music"; then music_created=true; fi
    root mkdir -p "$music" "$data"
    if [ "$music_created" = true ]; then
        music_owned=1
    elif [ "$existing" = true ] && [ "$(get_env KROBI_MUSIC_CREATED)" = 1 ]; then
        music_owned=1
    fi
    uid=$(root stat -c %u "$music") gid=$(root stat -c %g "$music")
    if [ "$uid" = 0 ]; then
        uid=${SUDO_UID:-1000} gid=${SUDO_GID:-1000}
        if [ "$music_created" = true ]; then root chown "$uid:$gid" "$music"; fi
    fi
    image=${KROBI_IMAGE:-} tag=${KROBI_TAG:-}
    if [ "$existing" = true ]; then
        image=${image:-$(get_env KROBI_IMAGE)} tag=${tag:-$(get_env KROBI_TAG)}
        uid=$(get_env PUID) gid=$(get_env PGID)
    fi
    image=${image:-ghcr.io/flipspin/flipspin-server} tag=${tag:-latest}
    image=$(canonical_image "$image")
    valid_value "$image"; valid_value "$tag"
    case "$image" in *[!a-zA-Z0-9./_:-]*|'') fail 'Invalid image name.' ;; esac
    case "$tag" in *[!a-zA-Z0-9_.-]*|'') fail 'Invalid tag.' ;; esac
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT HUP INT TERM
    case "$tag" in
        latest) resolved_tag=$(resolve_release) ;;
        *) resolved_tag=$tag ;;
    esac
    # main is an explicit development opt-in; a checkout is not an opt-in.
    if [ "${KROBI_HELPER_REF:-}" = main ]; then
        helper_ref=main
    elif [ -n "${KROBI_HELPER_REF:-}" ]; then
        fail 'KROBI_HELPER_REF only accepts main for development.'
    else
        [ "$resolved_tag" != latest ] || fail 'Could not resolve the release tag to download the helper. Check your connection and try again, or set KROBI_TAG=X.Y.Z.'
        helper_ref=v$resolved_tag
    fi
    curl -fsSL --connect-timeout 3 --max-time 15 \
        "https://raw.githubusercontent.com/flipspin/flipspin/$helper_ref/deploy/krobi" -o "$tmp/krobi" || fail 'Could not download the release helper. Check your connection and the tag.'
    cat >"$tmp/compose.yml" <<'COMPOSE'
# Managed by krobi installer
services:
  flipspin:
    image: "${KROBI_IMAGE:-ghcr.io/flipspin/flipspin-server}:${KROBI_IMAGE_TAG:-${KROBI_TAG:-latest}}"
    hostname: krobi
    restart: unless-stopped
    ports:
      - "${KROBI_PORT:-8000}:8000"
    volumes:
      - type: bind
        source: "${KROBI_MUSIC_DIR}"
        target: /music
      - type: bind
        source: "${KROBI_DATA_DIR}"
        target: /data
    environment:
      KROBI_INSTALL_METHOD: "script"
      KROBI_TAG: "${KROBI_TAG:-latest}"
      PUID: "${PUID:-1000}"
      PGID: "${PGID:-1000}"
      KROBI_REQUIRE_SETUP_TOKEN: "true"
COMPOSE
    {
        printf '# Managed by krobi installer\n'
        printf "KROBI_IMAGE_TAG='%s'\n" "$resolved_tag"
        printf "KROBI_IMAGE='%s'\nKROBI_TAG='%s'\n" "$image" "$tag"
        printf "KROBI_MUSIC_DIR='%s'\nKROBI_DATA_DIR='%s'\nKROBI_PORT='%s'\n" "$music" "$data" "$port"
        printf "KROBI_MUSIC_CREATED='%s'\n" "$music_owned"
        printf "PUID='%s'\nPGID='%s'\n" "$uid" "$gid"
    } >"$tmp/.env"
    root install -m 600 "$tmp/.env" /opt/krobi/.env
    root install -m 644 "$tmp/compose.yml" /opt/krobi/compose.yml
    root install -m 755 "$tmp/krobi" /usr/local/bin/krobi
    root install -m 755 "$tmp/krobi" /usr/local/bin/flipspin
    # Helper owns pull, local-image fallback, readiness and the timeout hint.
    root /usr/local/bin/flipspin update
    log 'Installation ready. Log: /opt/krobi/install.log'
    # Select the primary route's private source IP, then other private addresses.
    primary=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([^ ]*\).*/\1/p' || true)
    lan_ip=$({ printf '%s\n' "$primary"; ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}'; hostname -I 2>/dev/null | tr ' ' '\n'; } | awk -F. '
        NF == 4 && ($1 == 10 || ($1 == 172 && $2 >= 16 && $2 <= 31) || ($1 == 192 && $2 == 168)) {print; exit}')
    if [ -z "$lan_ip" ]; then
        lan_ip=$(hostname -I | awk '{print $1}')
        log 'No private IPv4 address was found. Check the address before connecting from the app.'
    fi
    [ -n "$lan_ip" ] || fail 'No network address was found. Check ip -4 addr and use the configured port.'
    status=$(curl --noproxy '*' -fsS --max-time 5 "http://127.0.0.1:$port/api/status")
    address="http://$lan_ip:$port"
    token=
    if printf '%s' "$status" | grep -Eq '"isInit"[[:space:]]*:[[:space:]]*false'; then
        token=$(root cat "$data/Krobi/setup-token")
        case "$token" in ''|*[!a-zA-Z0-9_-]*) fail 'The setup code has an unexpected format.' ;; esac
        [ "${#token}" -ge 20 ] && [ "${#token}" -le 128 ] || fail 'The setup code has an unexpected format.'
    fi
    # Use the running server's version, including when following :latest.
    running_version=$(printf '%s' "$status" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    link=
    if [ -n "$token" ]; then link="krobi://$lan_ip:$port/setup#$token"; fi
    print_ending "${running_version:-unknown}" "$address" "$link" "$token"
}

# One compound command: sh must read the whole script before prompting on tty.
main "$@"
