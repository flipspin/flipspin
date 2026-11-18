/**
 * Build backend with PyInstaller using the repo's .venv.
 * Run from root: node scripts/build-backend.cjs
 */
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const backendDir = path.join(repoRoot, "backend");
// Tauri bundles this stable resource directory. Keeping the platform-specific
// backend here prevents a package from reusing another platform's output.
const distPath = path.join(repoRoot, "src-tauri", "resources", "backend");
fs.mkdirSync(distPath, { recursive: true });

const isWin = process.platform === "win32";
const venvPython = isWin
  ? path.join(repoRoot, ".venv", "Scripts", "python.exe")
  : path.join(repoRoot, ".venv", "bin", "python");

const result = spawnSync(
  venvPython,
  [
    "-m",
    "PyInstaller",
    "--clean",
    "--additional-hooks-dir",
    path.join(repoRoot, "scripts", "pyinstaller"),
    "--distpath",
    distPath,
    "--name",
    "krobi-backend",
    "--onefile",
    // zeroconf (the LAN advertiser, app/infra/discovery.py) is largely
    // Cython-compiled and imports its internals lazily, and ifaddr picks its
    // platform module at runtime; static analysis misses both.
    "--collect-submodules",
    "zeroconf",
    "--collect-submodules",
    "watchdog",
    "--collect-submodules",
    "ifaddr",
    // Private plugins still import app.core.* for one compatibility release.
    // No backend module imports those aliases, so collect them explicitly.
    "--collect-submodules",
    "app.core",
    "--hidden-import",
    "sqlite3",
    "run_standalone.py",
  ],
  {
    cwd: backendDir,
    stdio: "inherit",
  }
);

if (result.status === 0) {
  // Clean the old npm binary on rebuilds too. Keep the imageio fallback off
  // PATH so an installed ffmpeg wins and provenance remains accurate.
  const binDir = path.join(distPath, "bin");
  for (const name of ["ffmpeg", "ffmpeg.exe"]) {
    fs.rmSync(path.join(binDir, name), { force: true });
  }
  try {
    const locate = spawnSync(venvPython, ["-c",
      "from app.infra.ffmpeg import bundled_ffmpeg_path; print(bundled_ffmpeg_path())"],
      { cwd: backendDir, encoding: "utf8" });
    const ffmpegPath = locate.stdout?.trim();
    if (locate.error || locate.status !== 0 || !ffmpegPath || !fs.existsSync(ffmpegPath)) {
      throw new Error(`imageio-ffmpeg has no binary for ${process.platform}-${process.arch}`);
    }
    const ffmpegDir = path.join(distPath, "ffmpeg");
    fs.rmSync(ffmpegDir, { recursive: true, force: true });
    fs.mkdirSync(ffmpegDir, { recursive: true });
    const target = path.join(ffmpegDir, isWin ? "ffmpeg.exe" : "ffmpeg");
    fs.copyFileSync(ffmpegPath, target);
    if (!isWin) fs.chmodSync(target, 0o755);
    for (const flag of ["-version", "-L"]) {
      const probe = spawnSync(target, [flag], { encoding: "utf8" });
      if (probe.error || probe.status !== 0) {
        throw new Error(`Staged imageio ffmpeg is not runnable: ${probe.error || probe.stderr}`);
      }
      if (/--enable-nonfree|nonfree parts compiled in|not legally redistributable/i.test(`${probe.stdout} ${probe.stderr}`)) {
        throw new Error("Staged ffmpeg contains nonfree parts; refusing to package");
      }
    }
    console.log(`Staged imageio-ffmpeg ${process.platform}-${process.arch}: ${target}`);
  } catch (error) {
    console.error("Cannot package without redistributable bundled ffmpeg:", error);
    process.exit(1);
  }
}

// The desktop beforeBuildCommand runs build-helper.cjs on every build, staging
// the helper, compatibility and statically linked KeyFinder wheels in resources/backend/helper-worker/.
// A frontend-only update must never silently ship an old engine wheel.
process.exit(result.status ?? 1);
