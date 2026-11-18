/** Stage the current worker on EVERY desktop build, independently of PyInstaller. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
// An alternate output keeps verification builds out of desktop resources.
const outputIndex = process.argv.indexOf("--out-dir");
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error("--out-dir requires a directory");
const target = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.join(root, "src-tauri/resources/backend/helper-worker");
require("./check-worker-release.cjs");
const bundledUv = path.join(root, "src-tauri/resources/backend/bin", process.platform === "win32" ? "uv.exe" : "uv");
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "krobi-helper-build-"));
try {
  // Build the native KeyFinder bridge on the installer host (C/C++ toolchain
  // required), alongside the two portable wheels. All three ship for offline installs.
  for (const project of ["helper", "helper/compat", "helper/keyfinder"]) {
    const result = spawnSync(fs.existsSync(bundledUv) ? bundledUv : "uv", ["build", "--python", "3.12", "--wheel", "--out-dir", staging, path.join(root, project)], { stdio: "inherit", env: { ...process.env, ...(process.platform === "darwin" ? { MACOSX_DEPLOYMENT_TARGET: "11.0" } : {}) } });
    if (result.error || result.status !== 0) throw new Error("Could not build the helper; refusing to bundle an outdated engine.");
  }
  const wheels = fs.readdirSync(staging).filter((file) => file.endsWith(".whl"));
  if (wheels.length !== 3 || !wheels.some(f => f.startsWith("krobi_helper-")) || !wheels.some(f => f.startsWith("krobi_lyrics-")) || !wheels.some(f => f.startsWith("krobi_keyfinder-"))) throw new Error("Expected the helper, compatibility and KeyFinder wheels.");
  fs.mkdirSync(target, { recursive: true });
  for (const wheel of wheels) fs.copyFileSync(path.join(staging, wheel), path.join(target, wheel));
  for (const file of fs.readdirSync(target)) {
    if ((file.startsWith("krobi_helper-") || file.startsWith("krobi_lyrics-") || file.startsWith("krobi_keyfinder-")) && file.endsWith(".whl") && !wheels.includes(file)) fs.unlinkSync(path.join(target, file));
  }
  console.log(`Staged ${wheels.join(", ")}`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
