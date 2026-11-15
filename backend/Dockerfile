# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# KROBI_CREDENTIALS_DIR is a path; credentials arrive through the environment.
# Build from the repository root; see docs/qa-install.md for image usage.
# The image uses system ffmpeg and excludes helper ML dependencies.
# Compile checksummed ffmpeg sources with audio and cover-image codecs only.

# ===========================================================================
# Stage 1 -- audio/cover ffmpeg + ffprobe (native on amd64 and arm64)
# ===========================================================================
FROM python:3.12-slim-trixie AS ffmpeg-builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config nasm curl git ca-certificates xz-utils \
      libmp3lame-dev libopus-dev libvorbis-dev libssl-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
COPY backend/ffmpeg-build.sh /tmp/ffmpeg-build.sh
RUN sh /tmp/ffmpeg-build.sh

# ===========================================================================
# Stage 2 -- Python dependencies; desktop keeps its imageio fallback
# ===========================================================================
FROM python:3.12-slim-trixie AS builder
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
COPY backend/requirements-server.txt /tmp/requirements-server.txt
RUN pip install --upgrade pip setuptools wheel \
 && pip install --no-cache-dir --compile -r /tmp/requirements-server.txt \
 && pip uninstall -y pip setuptools wheel \
 && python -c "import importlib.util; assert all(importlib.util.find_spec(p) is None for p in ('pip', 'setuptools', 'wheel', 'imageio_ffmpeg'))"

# Keep installed packages intact, including numpy testing support.

# ===========================================================================
# Stage 3 -- runtime
# ===========================================================================
FROM python:3.12-slim-trixie AS runtime

# Filled in by the release workflow (docker/metadata-action adds the same
# labels again, with the tag); a local build just says "dev".
ARG KROBI_VERSION=dev
ARG KROBI_REVISION=unknown
ARG KROBI_CREATED=unknown

LABEL org.opencontainers.image.title="Flipspin server" \
      org.opencontainers.image.description="Self-hosted music server: library, catalog browsing that marks what you own, acquisition, household accounts, .lrc lyrics." \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${KROBI_VERSION}" \
      org.opencontainers.image.revision="${KROBI_REVISION}" \
      org.opencontainers.image.created="${KROBI_CREATED}"

# Default numeric owner of /data and of the running process. Overridden at
# RUN time with PUID/PGID (see docker-entrypoint.sh), so a prebuilt image fits
# any host's music-folder owner -- 1000:1000 on most Linux boxes, 99:100 on
# Unraid. The build args remain for people who prefer to bake it in.
ARG KROBI_UID=1000
ARG KROBI_GID=1000

# FFmpeg's external audio/image libraries only. No Debian ffmpeg/libav* packages.
# tini reaps subprocesses and forwards SIGTERM; setpriv is supplied by util-linux.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini gpgv libmp3lame0 libopus0 libvorbis0a libvorbisenc2 libssl3t64 zlib1g \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg-builder /opt/ffmpeg/ /usr/local/
RUN ffmpeg -version && ffprobe -version

# HOME and KROBI_CREDENTIALS_DIR must resolve to the same persisted .env,
# so credentials saved through Settings are loaded again after restart.
# /music is separate from state; KROBI_MUSIC_DIR selects it at startup.
# Existing installs must retain their music path to preserve absolute playlists.
# Require a setup token so the first reachable client cannot claim the server.
ENV KROBI_INSTALL_METHOD=compose \
    HOME=/data \
    KROBI_MUSIC_DIR=/music \
    KROBI_PLAYLIST_DIR=/data/Krobi/playlists \
    KROBI_TEMP_DIR=/data/Krobi/temp \
    KROBI_LOG_DIR=/data/Krobi/logs \
    KROBI_CREDENTIALS_DIR=/data/Krobi/credentials \
    KROBI_BACKEND_HOST=0.0.0.0 \
    KROBI_BACKEND_PORT=8000 \
    KROBI_REQUIRE_SETUP_TOKEN=true \
    KROBI_LOG_LEVEL=INFO \
    PUID=${KROBI_UID} \
    PGID=${KROBI_GID} \
    PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

RUN groupadd --gid "${KROBI_GID}" krobi \
 && useradd --uid "${KROBI_UID}" --gid "${KROBI_GID}" --home-dir /data --no-create-home --shell /usr/sbin/nologin krobi \
 && mkdir -p /app \
             /music \
             /data/Krobi/playlists \
             /data/Krobi/temp \
             /data/Krobi/logs \
             /data/Krobi/credentials \
 && chown -R "${KROBI_UID}:${KROBI_GID}" /data /music

COPY --from=builder /opt/venv /opt/venv
# The code is root-owned and read-only to the server process: nothing in the
# app writes next to itself, and a compromised process cannot rewrite it.
COPY backend/app /app/app
COPY --chmod=0755 backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

WORKDIR /app

# NO `USER krobi` line, on purpose. The entrypoint starts as root only long
# enough to (1) move the krobi user to PUID/PGID and (2) fix ownership of
# /data, then drops to that user with setpriv before anything of KROBI runs.
# uvicorn never runs as root. `docker run --user 1000:1000` still works: the
# entrypoint sees it is not root and just execs.
EXPOSE 8000

# No curl/wget in python:3.12-slim, and adding them just for this is silly.
# "/" is the app's cheapest 200 and is defined in app/main.py itself, so it
# cannot drift. app/domains/system/routes.py also exposes a richer GET /api/health that
# reports whether the configured directories exist -- better for a monitoring
# probe, but "/" is the right choice for a liveness check that must never
# fail for a reason other than "the process is dead".
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/', timeout=4).status == 200 else 1)"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

# Bind outside container loopback so clients can reach the server.
# App request logs omit query credentials; uvicorn access logs expose them.
# Use one worker: progress/SSE state is process-local.
ENV FORWARDED_ALLOW_IPS=127.0.0.1
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--timeout-keep-alive", "75", \
     "--proxy-headers", \
     "--no-access-log"]
