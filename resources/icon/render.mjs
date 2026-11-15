// Rasterises the icon SVGs with a real browser. Run from the repo root:
//   node resources/icon/render.mjs
// ImageMagick's own SVG renderer drops some strokes and nested transforms, so
// every PNG master comes from Chromium instead.
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const dir = 'resources/icon'
const icon = await readFile(`${dir}/krobi-icon.svg`, 'utf8')
const figure = await readFile(`${dir}/krobi-figure.svg`, 'utf8')

// macOS (Big Sur grid): the artwork on an 824 px rounded square in a 1024 canvas, soft shadow.
const macos = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><filter id="s" x="-10%" y="-10%" width="120%" height="125%">
    <feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#000" flood-opacity=".35"/></filter>
  <clipPath id="c"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#2F6FE0" filter="url(#s)"/>
  <g clip-path="url(#c)"><svg x="100" y="100" width="824" height="824" viewBox="60 -10 960 960">${
    icon.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}</svg></g>
</svg>`

const jobs = [
  { svg: icon, size: 1024, out: `${dir}/krobi-1024.png`, transparent: false },
  { svg: macos, size: 1024, out: `${dir}/krobi-macos-1024.png`, transparent: true },
  { svg: figure, size: 1024, out: `${dir}/krobi-figure-1024.png`, transparent: true },
  { svg: icon, size: 128, out: 'renderer/src/assets/krobi-mark.png', transparent: false },
]

const browser = await chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 1 })
for (const { svg, size, out, transparent } of jobs) {
  await page.setViewportSize({ width: size, height: size })
  const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)
  await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`)
  await page.screenshot({ path: out, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } })
  console.log('wrote', out)
}
await browser.close()
