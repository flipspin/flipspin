// Fixture album covers (ten albums plus the Explore catalog album), one bachelor-level math/physics idea each, all procedural SVG.
export function makeCover(names) {
  const sans = 'Helvetica Neue, Helvetica, Arial, sans-serif', serif = 'Georgia, Times New Roman, serif', mono = 'Menlo, Courier New, monospace'
  const svg = (bg, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="${bg}"/>${body}</svg>`
  const range = n => Array.from({ length: n }, (_, k) => k)
  const f = v => Math.round(v * 10) / 10
  const path = pts => 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')
  const cap = (x, y, s, c, anchor = 'start') => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${mono}" font-size="13" fill="${c}">${s}</text>`
  const designs = [
    // Kepler orbits loosening into a hyperbolic escape
    ([a, b]) => { const sx = 300, sy = 230, p = 70
      const orbit = e => { const pts = []; for (let t = -Math.PI; t <= Math.PI; t += 0.02) { const d = 1 + e * Math.cos(t); if (d < 0.18) continue; const r = p / d; pts.push([sx + r * Math.cos(t), sy - r * Math.sin(t)]) } return pts }
      const esc = orbit(1.35).filter(([x, y]) => y <= sy + 1 && y > 14).reverse()
      return svg('#121c33', [0.15, 0.45, 0.7].map((e, k) => `<path d="${path(orbit(e))}Z" fill="none" stroke="#e9dcc0" stroke-width="1.4" stroke-dasharray="${k === 2 ? '' : '3 5'}" opacity="${0.35 + k * 0.25}"/>`).join('')
        + `<path d="${path(esc)}" fill="none" stroke="#f0a35e" stroke-width="2.6"/><circle cx="${f(esc[0][0] + 0)}" cy="${f(esc[0][1] + 0)}" r="8" fill="#f0a35e"/><circle cx="${sx}" cy="${sy}" r="16" fill="#f6d27a"/>`
        + `<text x="36" y="456" font-family="${serif}" font-style="italic" font-size="34" fill="#e9dcc0">${a.toLowerCase()}</text><text x="36" y="484" font-family="${mono}" font-size="13" letter-spacing="3" fill="#7fb3c9">${b.toUpperCase()}</text>` + cap(476, 48, 'e &gt; 1', '#f0a35e', 'end')) },
    // Phyllotaxis: seeds packing outward at the golden angle
    ([a, b]) => svg('#a9552f', range(420).map(n => { const t = n * 137.508 * Math.PI / 180, r = 10.6 * Math.sqrt(n); return `<circle cx="${f(256 + r * Math.cos(t))}" cy="${f(236 + r * Math.sin(t))}" r="${f(1.5 + n / 90)}" fill="${n % 21 === 0 ? '#2d1b14' : n % 13 === 0 ? '#f08a5d' : '#f3d9a4'}"/>` }).join('')
      + `<rect x="0" y="448" width="512" height="64" fill="#2d1b14"/><text x="28" y="488" font-family="${sans}" font-weight="700" font-size="24" fill="#f3d9a4">${a}</text>` + cap(484, 476, 'θ = n · 137.508°', '#f08a5d', 'end') + cap(484, 496, 'r = c√n', '#f08a5d', 'end')),
    // Beat frequency: two close tones, and what they make together
    ([a, b]) => { const w = (fr, amp, y0) => range(257).map(k => [k * 2, y0 - amp * Math.sin(k * 2 * fr)])
      const sum = range(513).map(x => [x, 330 - 22 * (Math.sin(x * 0.19) + Math.sin(x * 0.215))])
      const env = s => range(513).map(x => [x, 330 + s * 44 * Math.abs(Math.cos(x * 0.0125))])
      return svg('#141414', `<path d="${path(w(0.19, 14, 150))}" fill="none" stroke="#ece8df" stroke-width="1.4" opacity=".6"/><path d="${path(w(0.215, 14, 200))}" fill="none" stroke="#ece8df" stroke-width="1.4" opacity=".6"/>`
        + `<path d="${path(sum)}" fill="none" stroke="#ece8df" stroke-width="2.2"/>` + [1, -1].map(s => `<path d="${path(env(s))}" fill="none" stroke="#e7c55b" stroke-width="1.6" stroke-dasharray="4 4"/>`).join('')
        + `<text x="36" y="96" font-family="${serif}" font-size="52" fill="#ece8df">${a}</text><text x="38" y="470" font-family="${mono}" font-size="14" letter-spacing="4" fill="#ece8df" opacity=".7">${b.toUpperCase()}</text>` + cap(476, 470, 'f = |f₁ − f₂|', '#e7c55b', 'end')) },
    // Fourier series: harmonics adding up to a square wave, Gibbs at the corners
    ([a, b]) => { const sq = N => range(441).map(k => { const x = k / 440 * 4 * Math.PI; let s = 0; for (let j = 1; j <= N; j += 2) s += Math.sin(j * x) / j; return [36 + k, 250 - 95 * 4 / Math.PI * s] })
      return svg('#efeadf', `<path d="M36 250H476" stroke="#2f5f8a" stroke-width="1" opacity=".4"/>` + [[1, 0.25, 1.2], [3, 0.35, 1.2], [7, 0.5, 1.2], [31, 1, 2.6]].map(([N, o, sw]) => `<path d="${path(sq(N))}" fill="none" stroke="${N === 31 ? '#d9534f' : '#2f5f8a'}" stroke-width="${sw}" opacity="${o}"/>`).join('')
        + `<text x="256" y="76" text-anchor="middle" font-family="${sans}" font-weight="700" font-size="26" letter-spacing="10" fill="#2f5f8a">${a.toUpperCase()}</text><text x="256" y="448" text-anchor="middle" font-family="${mono}" font-size="13" letter-spacing="3" fill="#2f5f8a">${b.toUpperCase()}</text>` + cap(256, 476, 'f(x) = 4/π · Σ sin((2k−1)x) / (2k−1)', '#2f5f8a', 'middle')) },
    // Dispersion: one white beam, refracted twice, leaves as a spectrum
    ([a, b]) => { const cols = ['#ff5a5a', '#ff9f45', '#ffe066', '#7ee07e', '#5ab4ff', '#9a7bff']
      return svg('#000000', `<polygon points="256,120 380,360 132,360" fill="#f6e7b4" opacity=".12" stroke="#f6e7b4" stroke-width="1.5"/><path d="M0 300L214 232" stroke="#fff" stroke-width="4"/>`
        + cols.map((c, k) => `<path d="M214 232L${300 + k * 3} ${250 + k * 8}L512 ${330 + k * 24}" fill="none" stroke="${c}" stroke-width="3" opacity=".9"/>`).join('')
        + `<text x="36" y="70" font-family="${sans}" font-weight="300" font-size="30" fill="#f6e7b4">${a}</text><text x="36" y="98" font-family="${sans}" font-size="16" fill="#e8a2c0">${b}</text>` + cap(36, 478, 'n₁ sin θ₁ = n₂ sin θ₂', '#f6e7b4')) },
    // Dipole: field lines r = k sin²θ looping pole to pole
    ([a, b]) => svg('#d7322b', [40, 70, 110, 160, 230, 320].map(k => [1, -1].map(s => { const pts = range(181).map(i => { const t = i / 180 * Math.PI, r = k * Math.sin(t) ** 2; return [256 + s * r * Math.sin(t), 256 - r * Math.cos(t)] }); return `<path d="${path(pts)}" fill="none" stroke="#f4ede1" stroke-width="1.6" opacity=".85"/>` }).join('')).join('')
      + `<rect x="246" y="226" width="20" height="60" rx="3" fill="#141414"/><rect x="246" y="226" width="20" height="30" rx="3" fill="#f4ede1"/>`
      + `<text x="-6" y="500" font-family="${sans}" font-weight="900" font-size="74" letter-spacing="-4" fill="#141414">${a.split(' ')[0].toUpperCase()}</text>` + cap(476, 40, 'B ∝ 1/r³', '#f4ede1', 'end') + cap(36, 40, b.toLowerCase(), '#f4ede1')),
    // Lorenz: two starts 1e-5 apart, same butterfly, different paths
    ([a, b]) => { const run = x0 => { let [x, y, z] = [x0, 1, 1.05]; const out = []; const d = (x, y, z) => [10 * (y - x), x * (28 - z) - y, x * y - 8 / 3 * z]
        for (let i = 0; i < 3200; i++) { const h = 0.01, k1 = d(x, y, z), k2 = d(x + h / 2 * k1[0], y + h / 2 * k1[1], z + h / 2 * k1[2]), k3 = d(x + h / 2 * k2[0], y + h / 2 * k2[1], z + h / 2 * k2[2]), k4 = d(x + h * k3[0], y + h * k3[1], z + h * k3[2]); x += h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]); y += h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]); z += h / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]); if (i % 2 === 0) out.push([256 + x * 9, 450 - z * 8.2]) } return out }
      return svg('#0f2a22', `<path d="${path(run(1))}" fill="none" stroke="#7fd1b9" stroke-width="1" opacity=".75"/><path d="${path(run(1.00001))}" fill="none" stroke="#f2b880" stroke-width="1" opacity=".75"/>`
        + `<text x="34" y="66" font-family="${sans}" font-weight="700" font-size="36" fill="#c9f2df">${a}</text><text x="36" y="92" font-family="${mono}" font-size="14" fill="#7fd1b9">${b.toLowerCase()}</text>` + cap(476, 490, 'ẋ = σ(y − x) · σ=10 ρ=28 β=8/3', '#c9f2df', 'end')) },
    // L-system: one rule rewritten four times grows a tree
    ([a, b]) => { let s = 'F'; for (let i = 0; i < 4; i++) s = s.replace(/F/g, 'FF-[-F+F+F]+[+F-F-F]')
      let x = 0, y = 0, ang = -Math.PI / 2; const st = [], segs = [], da = 22.5 * Math.PI / 180
      for (const c of s) { if (c === 'F') { const nx = x + Math.cos(ang), ny = y + Math.sin(ang); segs.push([x, y, nx, ny]); x = nx; y = ny } else if (c === '+') ang += da; else if (c === '-') ang -= da; else if (c === '[') st.push([x, y, ang]); else if (c === ']') [x, y, ang] = st.pop() }
      const xs = segs.flatMap(q => [q[0], q[2]]), ys = segs.flatMap(q => [q[1], q[3]]), x0 = Math.min(...xs), y0 = Math.min(...ys), k = Math.min(380 / (Math.max(...xs) - x0), 360 / (Math.max(...ys) - y0)), ox = 256 - k * (Math.max(...xs) + x0) / 2, oy = 70 - k * y0
      return svg('#bcd3df', `<path d="${segs.map(([p, q, r, t]) => `M${f(ox + k * p)} ${f(oy + k * q)}L${f(ox + k * r)} ${f(oy + k * t)}`).join('')}" stroke="#22394a" stroke-width="1" fill="none"/><circle cx="${f(ox)}" cy="${f(oy)}" r="5" fill="#d9534f"/>`
        + `<text x="36" y="482" font-family="${serif}" font-size="26" fill="#22394a">${a}</text>` + cap(476, 482, 'F → FF−[−F+F+F]+[+F−F−F]', '#22394a', 'end') + cap(36, 48, b.toLowerCase(), '#22394a')) },
    // Logistic map: one value, then two, four, then chaos
    ([a, b]) => { let d = ''
      for (let c = 0; c < 220; c++) { const r = 2.8 + c / 219 * 1.2; let v = 0.5; for (let i = 0; i < 300; i++) v = r * v * (1 - v); const seen = new Set(); for (let i = 0; i < 80; i++) { v = r * v * (1 - v); seen.add(Math.round(v * 300)) } for (const yy of seen) d += `M${36 + c * 2} ${380 - yy}h1.6v1.6h-1.6z` }
      return svg('#f7f3ea', `<path d="${d}" fill="#1d3f5a"/><path d="M36 380H476" stroke="#1d3f5a" opacity=".3"/>`
        + `<text x="36" y="430" font-family="${sans}" font-weight="700" font-size="28" fill="#1d3f5a">${a}</text><text x="36" y="456" font-family="${sans}" font-size="15" fill="#1d3f5a">${b}</text>` + cap(36, 490, 'xₙ₊₁ = r xₙ(1 − xₙ) · δ ≈ 4.669', '#3f8dc0')) },
    // Voronoi: a night sky of cloud cells, each the region nearest its own seed, looking up from the street.
    // The cells are a Voronoi diagram on a flat cloud ceiling (z = 1, x across, y away). A pinhole camera at the
    // origin, pitched 62° up, projects it: cells overhead are large, and toward the horizon (just below the frame)
    // they shrink and flatten, foreshortened. Seeds are a jittered grid so every cell is about the same size up there.
    ([a, b]) => { let seed = 9; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
      const pitch = 62 * Math.PI / 180, fl = 362, cp = Math.cos(pitch), sp = Math.sin(pitch)
      const proj = ([x, y]) => { const up = cp - y * sp, depth = y * cp + sp; return [256 + fl * x / depth, 256 - fl * up / depth] }
      const step = 0.19, pts = []
      for (let y = -0.6; y < 12; y += step) for (let x = -10; x < 10; x += step) {
        const px = x + r() * step, py = y + r() * step
        if (Math.abs(px) < 256 * (py * cp + sp) / fl + 0.6) pts.push([px, py]) }
      const clip = (poly, [px, py], [qx, qy]) => { const nx = qx - px, ny = qy - py, c = (nx * (px + qx) + ny * (py + qy)) / 2, side = ([x, y]) => nx * x + ny * y - c, out = []
        poly.forEach((A, i) => { const B = poly[(i + 1) % poly.length], sa = side(A), sb = side(B); if (sa <= 0) out.push(A); if (sa * sb < 0) { const t = sa / (sa - sb); out.push([A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])]) } }); return out }
      const near = new Map(); for (const q of pts) { const k = `${Math.floor(q[0] / step)},${Math.floor(q[1] / step)}`; near.set(k, [...(near.get(k) ?? []), q]) }
      const cells = pts.map(p => { const gx = Math.floor(p[0] / step), gy = Math.floor(p[1] / step); let poly = [[p[0] - 1, p[1] - 1], [p[0] + 1, p[1] - 1], [p[0] + 1, p[1] + 1], [p[0] - 1, p[1] + 1]]
        for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const q of near.get(`${gx + i},${gy + j}`) ?? []) if (q !== p) poly = clip(poly, p, q)
        return [proj(p), poly.map(proj), poly] })
      const shrink = ([, , poly], k) => { const cx = poly.reduce((s, q) => s + q[0], 0) / poly.length, cy = poly.reduce((s, q) => s + q[1], 0) / poly.length; return poly.map(([x, y]) => proj([cx + k * (x - cx), cy + k * (y - cy)])) }
      return svg('#a39a7c', `<defs><filter id="vb" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter><linearGradient id="vg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14161c" stop-opacity=".55"/><stop offset=".6" stop-color="#14161c" stop-opacity="0"/></linearGradient></defs>`
        + `<g filter="url(#vb)">${cells.map(c => `<path d="${path(shrink(c, 0.7 + r() * 0.12))}Z" fill="${['#2b2f38', '#353a44', '#3f434b'][Math.floor(r() * 3)]}"/>`).join('')}</g>`
        + `<g opacity=".12">${cells.map(([, poly]) => `<path d="${path(poly)}Z" fill="none" stroke="#efe4c4" stroke-width=".8"/>`).join('')}</g>`
        + `<rect width="512" height="512" fill="url(#vg)"/>${(([, poly]) => { const sx = poly.reduce((s, q) => s + q[0], 0) / poly.length, sy = poly.reduce((s, q) => s + q[1], 0) / poly.length; return `<g filter="url(#vb)"><ellipse cx="${f(sx + 2)}" cy="${f(sy - 1)}" rx="16" ry="7" fill="#fff4d6" opacity=".38" transform="rotate(-28 ${f(sx)} ${f(sy)})"/><ellipse cx="${f(sx - 3)}" cy="${f(sy + 2)}" rx="6" ry="11" fill="#dfe8ff" opacity=".3"/><ellipse cx="${f(sx + 5)}" cy="${f(sy + 3)}" rx="7" ry="4" fill="#fff" opacity=".45"/></g><circle cx="${f(sx)}" cy="${f(sy)}" r="2.6" fill="#fff" opacity=".35"/><circle cx="${f(sx)}" cy="${f(sy)}" r="1.5" fill="#fff"/>` })(cells.reduce((m, c) => Math.hypot(c[0][0] - 290, c[0][1] - 225) < Math.hypot(m[0][0] - 290, m[0][1] - 225) ? c : m))}`
        + `<text x="36" y="70" font-family="${serif}" font-style="italic" font-size="38" fill="#f3ead2">${a.toLowerCase()}</text><text x="38" y="96" font-family="${mono}" font-size="13" letter-spacing="3" fill="#d9cfb0">${b.toUpperCase()}</text>` + cap(476, 492, 'V(pᵢ) = { x : |x − pᵢ| ≤ |x − pⱼ| ∀ j }', '#f3ead2', 'end')) },
    // Chladni figures: sand settles where a vibrating plate stays still
    ([a, b]) => { let d = '', seed = 3; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
      const n = 3, m = 7, P = Math.PI, F = (x, y) => Math.cos(n * P * x) * Math.cos(m * P * y) - Math.cos(m * P * x) * Math.cos(n * P * y)
      for (let k = 0; k < 42000; k++) { const x = r(), y = r(); if (Math.abs(F(x, y)) < 0.045) d += `M${f(56 + x * 400)} ${f(40 + y * 400)}h1.4v1.4h-1.4z` }
      return svg('#17181c', `<rect x="56" y="40" width="400" height="400" fill="#23252b"/><path d="${d}" fill="#e8dcc0"/>`
        + `<text x="56" y="478" font-family="${serif}" font-size="26" fill="#e8dcc0">${a}</text><text x="456" y="478" text-anchor="end" font-family="${mono}" font-size="12" letter-spacing="3" fill="#b9ad92">${b.toUpperCase()}</text>` + cap(56, 500, 'cos(nπx)cos(mπy) − cos(mπx)cos(nπy) = 0', '#b9ad92')) },
  ]
  return i => designs[i % designs.length](names[i % names.length])
}
