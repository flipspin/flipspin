// Sets the lockup (icon · Flipspin · tagline) in real Inter over the halftone cover; transparent output.
import { chromium } from 'playwright'
import { writeFileSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
// usage: node scripts/readme-cover/lockup.mjs <base.png> <out.png> [dark]
const root = path.resolve(import.meta.dirname, '../..'), work = mkdtempSync(path.join(tmpdir(), 'krobi-lockup-'))
for (const w of [600, 800]) copyFileSync(path.join(root, 'node_modules/@fontsource/inter/files', `inter-latin-${w}-normal.woff2`), path.join(work, `inter-latin-${w}-normal.woff2`))
copyFileSync(path.join(root, 'resources/icon/krobi-1024.png'), path.join(work, 'icon.png'))
const [baseArg, outArg, dark] = process.argv.slice(2)
const base = 'base.png', out = path.resolve(outArg)
copyFileSync(path.resolve(baseArg), path.join(work, base))
const ink = dark === 'dark' ? '#EEEFE8' : '#151515', line = '#151515'
writeFileSync(path.join(work, 'lockup.html'), `<!doctype html><html><head><style>
@font-face{font-family:I;font-weight:800;src:url(inter-latin-800-normal.woff2)}
@font-face{font-family:I;font-weight:600;src:url(inter-latin-600-normal.woff2)}
html,body{margin:0;background:transparent}
.c{position:relative;width:1600px;height:598px}
.c>img{position:absolute;inset:0}
.l{position:absolute;left:2px;top:2px;display:flex;flex-direction:column;gap:10px;font-family:I}
.r{display:flex;align-items:center;gap:16px}
.r img{width:92px;height:92px;box-sizing:border-box;border:3px solid ${line};border-radius:21px;box-shadow:5px 5px 0 ${line};display:block}
.k{font-size:104px;font-weight:800;letter-spacing:-4.5px;line-height:.9;color:${ink}}
.t{font-size:26px;font-weight:600;color:${ink};letter-spacing:-.3px;line-height:1.2}
</style></head><body><div class="c"><img src="${base}"><div class="l"><div class="r"><img src="icon.png"><span class="k">Flipspin</span></div><span class="t">Music you own,<br>on hardware you own.</span></div></div></body></html>`)
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 598 }, deviceScaleFactor: 1 })
await p.goto('file://' + path.join(work, 'lockup.html')); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300)
await p.locator('.c').screenshot({ path: out, omitBackground: true }); await b.close(); console.log(out)
