/** Ban numeric interface durations and ratchet raw colors, z-index values, index.css size
 * and bare missing-value dashes. Lower style-baseline.json only when counts decrease. */
import { existsSync, readdirSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const BASELINE_FILE = join(__dirname, "style-baseline.json");
const TOKEN_FILES = /^(ui\/tokens\/|styles\/theme\.css$|vendor\/)/;

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (name !== "node_modules" && name !== "generated") walk(path, ext, out);
    } else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(SRC, path).split("\\").join("/");
const cssFiles = walk(SRC, /\.css$/).filter((f) => !rel(f).startsWith("vendor/"));
const tsxFiles = walk(SRC, /\.tsx$/);

const DECL = /(?<![\w-])(transition|transition-duration|animation|animation-duration)\s*:\s*([^;{}]+)/g;
const TIME = /(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])/;

function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

function rawDurations(css: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(DECL)) {
    for (const item of splitTop(match[2])) {
      if (/infinite|var\(--dur/.test(item)) continue; // tokenized: any number left is a delay
      const time = item.match(TIME); // the first time is the duration; a second one is a delay
      if (!time) continue;
      const ms = Number.parseFloat(time[1]) * (time[2] === "s" ? 1000 : 1);
      if (ms > 0 && ms <= 700) found.push(`${match[1]}: ${item.trim()}`);
    }
  }
  return found;
}

function counts(): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  const add = (file: string, key: string, n: number) => {
    if (!n) return;
    (result[file] ??= {})[key] = n;
  };
  for (const path of cssFiles) {
    const file = rel(path);
    if (TOKEN_FILES.test(file)) continue;
    const css = readFileSync(path, "utf8");
    add(file, "hex", (css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length);
    add(file, "zIndex", (css.match(/z-index:\s*-?\d+/g) ?? []).length);
  }
  for (const path of tsxFiles) {
    const file = rel(path);
    const tsx = readFileSync(path, "utf8");
    add(file, "hex", (tsx.match(/#[0-9a-fA-F]{6}\b/g) ?? []).length);
    add(file, "zIndex", (tsx.match(/\bz-\[\d+\]|\bz-(?:[1-9]\d*)\b|zIndex:\s*\d+/g) ?? []).length);
    // A lone "—" as a string or JSX text: '—', "—", `—`, >—<, {"—"}, or on a line of its own.
    const code = tsx.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    add(file, "dash", (code.match(/['"`>]\s*—\s*['"`<]|^\s*—\s*$/gm) ?? []).length);
  }
  const index = join(SRC, "index.css");
  add("index.css", "lines", readFileSync(index, "utf8").split("\n").length);
  return result;
}

describe("style guard", () => {
  it("writes no CSS transition or animation duration as a number", () => {
    const offenders = cssFiles
      .filter((path) => !TOKEN_FILES.test(rel(path)))
      .flatMap((path) => rawDurations(readFileSync(path, "utf8")).map((d) => `${rel(path)} — ${d}`));
    expect(offenders, "use var(--dur-press | --dur-fast | --dur | --dur-slow), see ui/tokens/app.css").toEqual([]);
  });

  it("uses no numeric Tailwind duration class", () => {
    const offenders = tsxFiles.flatMap((path) =>
      (readFileSync(path, "utf8").match(/\bduration-(?:\d+|\[[^\]]+\])/g) ?? []).map((m) => `${rel(path)} — ${m}`),
    );
    expect(offenders, "use duration-(--dur-fast) and friends").toEqual([]);
  });

  it("never adds a raw colour, a raw z-index or a line to index.css (ratchet)", () => {
    const now = counts();
    if (process.env.UPDATE_STYLE_BASELINE === "1" || !existsSync(BASELINE_FILE)) {
      writeFileSync(BASELINE_FILE, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Record<string, Record<string, number>>;
    const grew: string[] = [];
    for (const [file, metrics] of Object.entries(now)) {
      for (const [key, n] of Object.entries(metrics)) {
        const floor = baseline[file]?.[key] ?? 0;
        if (n > floor) grew.push(`${file} ${key}: ${floor} → ${n}`);
      }
    }
    expect(grew, "use a token (theme.css colours, --z-* layers), <Missing> instead of a bare «—», or, for index.css, a component stylesheet").toEqual([]);
  });
});
