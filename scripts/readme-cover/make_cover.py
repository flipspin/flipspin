"""Flipspin README cover: a scanline halftone of the penguin rising out of a dashed field,
with app windows on the right. Technique:
12 px grid, one colour, glyph = full block / bar / dash / short dash / dot by darkness,
neighbours merge into lines, the field thins into dotted rows behind the windows.

usage: make_cover.py <figure.png> <front.png> <back.png> <out_prefix> <variant> [dark]
(needs numpy and Pillow; the README uses variant d, then lockup.mjs)
"""
import sys, math, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

FIG, FRONT, BACK, OUT, VAR = sys.argv[1:6]
DARK = len(sys.argv) > 6 and sys.argv[6] == 'dark'
W, H = 1600, 598
S = 2                                # supersample for clean edges
BLUE = (47, 111, 224, 255)           # Krobi blue, the icon's ground
ORANGE = (239, 126, 85, 255)         # paper palette coral, for the beak (variant c)
INK = (21, 21, 21, 255)

cfg = {
    'a': dict(pitch=12.3, fig_h=470, fig_x=150),
    'b': dict(pitch=16.0, fig_h=470, fig_x=150),
    'c': dict(pitch=12.3, fig_h=500, fig_x=130),
    'd': dict(pitch=12.3, fig_h=500, fig_x=130, sink=10),  # bigger; its base runs off the bottom edge   # c + lockup space + pixel melt
}[VAR]
P = cfg['pitch']


def rnd(x, y, k=0):
    v = math.sin(x * 127.1 + y * 311.7 + k * 74.7) * 43758.5453
    return v - math.floor(v)


# --- darkness map --------------------------------------------------------
fig = Image.open(FIG).convert('RGBA')
bbox = fig.getbbox(); fig = fig.crop(bbox)
fh = cfg['fig_h']; fw = round(fig.width * fh / fig.height)
fig = fig.resize((fw, fh), Image.LANCZOS)
fx, fy = cfg['fig_x'], H - fh + cfg.get('sink', 10)          # its base sinks into the field

fa = np.zeros((H, W)); fl = np.ones((H, W)); fo = np.zeros((H, W))
arr = np.asarray(fig).astype(float) / 255
ys, xs = slice(max(fy, 0), min(fy + fh, H)), slice(fx, fx + fw)
sub = arr[ys.start - fy:ys.stop - fy, :xs.stop - xs.start]
fa[ys, xs] = sub[..., 3]
lum = 0.3 * sub[..., 0] + 0.59 * sub[..., 1] + 0.11 * sub[..., 2]
fl[ys, xs] = lum
fo[ys, xs] = ((sub[..., 0] > .8) & (sub[..., 1] > .4) & (sub[..., 1] < .75) & (sub[..., 2] < .45)) * sub[..., 3]
figdark = fa * (1 - fl)                      # black body = 1, white face = 0, outside = 0


def field(x, y):
    """the ground: dense at the bottom-left, thinning upward and toward the right."""
    top = (410 if VAR == 'd' else 400) + 40 * (x / W) ** 1.4          # horizon rises slightly to the left
    if y < top - 40: return 0.0
    t = min(1.0, (y - (top - 40)) / 200)
    fade_x = max(0.0, 1 - max(0, x - 520) / 480)
    return max(0.0, min(0.52, t * (0.35 + 0.65 * fade_x)))  # the field never reaches block/bar: those belong to the figure


# --- glyphs ----------------------------------------------------------------
img = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
rows = int(H / P) + 1; cols = int(W / P) + 1
for r in range(rows):
    cy = (r + .5) * P
    for c in range(cols):
        cx = c * P
        x0, x1 = int(cx), int(min(cx + P, W - 1))
        y0, y1 = int(r * P), int(min(r * P + P, H - 1))
        if x1 <= x0 or y1 <= y0: continue
        inside = fa[y0:y1, x0:x1].mean()
        if inside > 0.35:
            v = figdark[y0:y1, x0:x1].mean() / max(inside, 1e-6)
            col = ORANGE if (VAR in 'cd' and fo[y0:y1, x0:x1].mean() > .25) else BLUE
            if VAR in 'cd' and col is ORANGE: v = max(v, .8)
        else:
            v = field(cx + P / 2, cy) * (0.75 + 0.5 * rnd(r, c))
            col = BLUE
        if v > .78:   h, w = P * .80, P          # full block
        elif v > .56: h, w = P * .62, P          # bar
        elif v > .36: h, w = P * .42, P * .92    # dash
        elif v > .18: h, w = P * .34, P * .62    # short dash
        elif v > .07: h, w = P * .26, P * .26    # dot
        else: continue
        L = (cx + (P - w) / 2) * S; R = L + w * S
        T = (cy - h / 2) * S; B = T + h * S
        d.rounded_rectangle([L, T, R, B], radius=min(h, w) * S * .5 if w < P else S, fill=col)
art = img.resize((W, H), Image.LANCZOS)


# --- windows -----------------------------------------------------------------
def window(path, width, line):
    shot = Image.open(path).convert('RGBA')
    shot = shot.resize((width, round(shot.height * width / shot.width)), Image.LANCZOS)
    m = Image.new('L', shot.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, shot.width - 1, shot.height - 1], radius=14, fill=255)
    framed = Image.new('RGBA', (shot.width + 4, shot.height + 4), (0, 0, 0, 0))
    ImageDraw.Draw(framed).rounded_rectangle([0, 0, framed.width - 1, framed.height - 1], radius=16, fill=line)
    framed.paste(shot, (2, 2), m)
    return framed


line = (0, 0, 0, 255) if DARK else INK
canvas = art.copy()
WINS = ((BACK, 900, 70, 900), (FRONT, 640, 200, 1000)) if VAR == 'd' else ((BACK, 900, 70, 900), (FRONT, 640, 230, 1000))
for path, x, y, w in WINS:
    win = window(path, w, line)
    shadow = Image.new('RGBA', win.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([0, 0, win.width - 1, win.height - 1], radius=16, fill=line)
    canvas.alpha_composite(shadow, (x + 8, y + 8)) if x + 8 < W else None
    canvas.alpha_composite(win, (x, y))
if VAR == 'd' and os.environ.get('MELT') == '1':
    # pixel melt (off by default) over the front window's top edge: solid squares in the palette's hues,
    # densest at the edge, thinning upward; inside the window some cells are cut out.
    HUES = [(239, 126, 85), (241, 216, 108), (79, 156, 139), (62, 111, 208), (138, 116, 216)] + ([(238, 239, 232)] * 2 if DARK else [(21, 21, 21)] * 2)
    Q = 23; fx0, fy0, fw0 = WINS[1][1], WINS[1][2], WINS[1][3]
    px = canvas.load(); dd = ImageDraw.Draw(canvas)
    for r in range(-5, 3):
        for c in range(int(fx0 / Q) - 1, int(W / Q) + 1):
            x0, y0 = c * Q, fy0 + r * Q
            if r < 0:
                p = 0.62 * (1 + r / 6) ** 2.2
                if rnd(r, c, 7) < p:
                    hue = HUES[int(rnd(r, c, 8) * len(HUES))]
                    dd.rectangle([x0, y0, x0 + Q - 1, y0 + Q - 1], fill=hue + (255,))
            else:
                p = 0.30 if r == 0 else 0.12
                if rnd(r, c, 9) < p and x0 >= fx0:
                    if rnd(r, c, 10) < 0.6:
                        for yy in range(y0, min(y0 + Q, H)):
                            for xx in range(x0, min(x0 + Q, W)):
                                px[xx, yy] = (0, 0, 0, 0)
                    else:
                        hue = HUES[int(rnd(r, c, 11) * len(HUES))]
                        dd.rectangle([x0, y0, x0 + Q - 1, y0 + Q - 1], fill=hue + (255,))
canvas.save(f'{OUT}.png')
for bg, name in (((255, 255, 255), 'onlight'), ((13, 17, 23), 'ondark')):
    b = Image.new('RGBA', canvas.size, bg + (255,)); b.alpha_composite(canvas); b.convert('RGB').save(f'{OUT}-{name}.png')
print(OUT, canvas.size)
