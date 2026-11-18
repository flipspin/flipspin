# The sole imageio ffmpeg binary is staged beside krobi-backend by
# build-backend.cjs. Override the upstream hook so --onefile doesn't embed a
# second copy. Keep the package importable for development/runtime inspection.
hiddenimports = ["imageio_ffmpeg.binaries"]
