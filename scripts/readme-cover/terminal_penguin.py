"""The Krobi penguin as terminal art, for the server installer's last screen.

The penguin in braille dots (each character is a 2 × 4 grid of dots: 30 columns ×
12 lines = 60 × 48 dots), drawn from resources/icon/krobi-figure-1024.png and
squashed a little because a terminal spaces braille rows wider than its dots.
Body, eyes and note in Krobi blue, the beak in the cover's coral, the face left as
the terminal's background. It stands on a dotted ground under a night sky with
stars and two shaded clouds.

usage: terminal_penguin.py <figure.png> <out_dir> [preview.png]
writes   scene.ansi        24-bit colour
         scene-256.ansi    256-colour fallback
         scene.txt         NO_COLOR
         penguin.ansi / penguin-256.ansi / penguin.txt   the penguin alone
and, with a third argument, a PNG of scene.ansi on a dark ground.
(needs numpy and Pillow, like make_cover.py)
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# One colour per key: 24-bit, xterm-256.
COLOURS = {
    'B': ((122, 160, 240), 111),    # Krobi blue softened for a dark terminal, #7AA0F0
    'O': ((239, 126, 85), 209),     # the cover's beak coral
    'g': ((110, 118, 129), 244),    # ground rule and clouds
    's': ((200, 205, 212), 251),    # stars
}

WIDTH, LINES = 64, 15
CLOUDS = [  # (top line, left column, rows)
    (3, 38, ['     ░░░░░░', '  ░░░░░░░░░░░░', '░░░░░░░░░░░░░░░░░░']),
    (8, 46, ['   ░░░░░░░', '░░░░░░░░░░░░░░░']),
]
STARS = [(1, 3), (1, 34), (2, 60), (4, 36), (6, 61), (2, 28), (7, 39), (11, 42), (12, 58), (6, 1)]
PENGUIN_AT = (2, 3)                  # top line, left column of the penguin
P_LINES, P_COLS = 12, 30
SOFTEN = 0.6                         # blur radius, in dots, before sampling
# Empty cells inside the penguin are the blank braille character, not a space: a font
# without braille draws the dots from a fallback whose width differs from its space,
# and rows with different mixes of spaces and dots then drift apart on the right.
BLANK = '\u2800'
DOTS = ((0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08),
        (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80))


def penguin_cells(figure):
    """The figure as P_LINES × P_COLS braille cells of (char, colour key, None)."""
    src = Image.open(figure).convert('RGBA')
    a = np.asarray(src.crop(src.getbbox())).astype(float) / 255
    r, g, b, alpha = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    ink = (alpha > .5) & (r + g + b < 1.0)                  # body, eyes, note
    beak = (alpha > .5) & (r > .7) & (g > .45) & (g < .8) & (b < .4)
    H, W = P_LINES * 4, P_COLS * 2

    def coverage(mask):
        # Blur the full-size mask by about half a dot before averaging it into dots, so a
        # dot on a curve takes the share of ink around it, not only inside its own box:
        # the contour steps one dot at a time instead of in whole-cell stairs.
        img = Image.fromarray((mask * 255).astype(np.uint8))
        img = img.filter(ImageFilter.GaussianBlur(SOFTEN * mask.shape[1] / W))
        img = img.resize((W, H), Image.LANCZOS)
        return np.asarray(img).astype(float) / 255

    cov_ink, cov_beak = coverage(ink), coverage(beak)
    # The head is symmetric and the note is not: below the note, average each row with
    # its mirror so an off-centre grid doesn't give the two eyes two shapes.
    head = round(H * 0.24)                 # the head's top, 24% down the cropped figure
    cov_ink[head:] = (cov_ink[head:] + cov_ink[head:, ::-1]) / 2
    cov_beak = (cov_beak + cov_beak[:, ::-1]) / 2
    is_beak = cov_beak > .40
    on = (cov_ink > .35) | is_beak   # low enough that thin edges keep two dots
    lines = []
    for cy in range(P_LINES):
        row = []
        for cx in range(P_COLS):
            bits, coral = 0, False
            for dx, dy, bit in DOTS:
                y, x = cy * 4 + dy, cx * 2 + dx
                if on[y, x]:
                    bits |= bit
                    coral |= bool(is_beak[y, x])
            row.append((chr(0x2800 + bits), 'O' if coral else 'B', None) if bits
                       else (BLANK, None, None))
        lines.append(row)
    return lines


def scene_cells(penguin):
    grid = [[(' ', None, None) for _ in range(WIDTH)] for _ in range(LINES)]
    for x in range(0, WIDTH, 2):
        grid[0][x] = grid[LINES - 1][x] = ('·', 'g', None)
    for top, left, rows in CLOUDS:
        for dy, row in enumerate(rows):
            for dx, ch in enumerate(row):
                if ch != ' ':
                    grid[top + dy][left + dx] = (ch, 'g', None)
    for y, x in STARS:
        grid[y][x] = ('*', 's', None)
    py, px = PENGUIN_AT
    for dy, line in enumerate(penguin):
        for dx, cell in enumerate(line):
            if cell[0] != ' ':
                grid[py + dy][px + dx] = cell
            elif grid[py + dy][px + dx][0] == '░':    # the penguin stands in front of clouds
                grid[py + dy][px + dx] = (' ', None, None)
    return grid


def render(grid, mode):
    """mode: 'true' 24-bit, '256', or 'plain' (NO_COLOR)."""
    out = []
    for line in grid:
        s, state = '', None
        last = max((i for i, (ch, _, _) in enumerate(line) if ch not in (' ', BLANK)), default=-1)
        for ch, fg, bg in line[:last + 1]:
            if mode == 'plain':
                s += ch
                continue
            want = (fg, bg) if ch != ' ' else (None, None)
            if want != state:
                codes = ['0']
                for key, base in ((want[0], 38), (want[1], 48)):
                    if key:
                        rgb, idx = COLOURS[key]
                        codes.append(f'{base};2;{rgb[0]};{rgb[1]};{rgb[2]}' if mode == 'true'
                                     else f'{base};5;{idx}')
                s += f'\x1b[{";".join(codes)}m'
                state = want
            s += ch
        if mode != 'plain' and state not in (None, (None, None)):
            s += '\x1b[0m'
        out.append(s)
    return '\n'.join(out) + '\n'


def preview(grid, path):
    """Braille drawn as its dots, other characters in Menlo, on a dark ground."""
    from PIL import ImageFont
    font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 22)
    cw, ch = 13, 28
    img = Image.new('RGB', (WIDTH * cw + 32, LINES * ch + 32), (13, 17, 23))
    d = ImageDraw.Draw(img)
    for y, line in enumerate(grid):
        for x, (c, fg, _) in enumerate(line):
            X, Y = 16 + x * cw, 16 + y * ch
            f = COLOURS[fg][0] if fg else None
            if 0x2800 < ord(c) <= 0x28FF:
                bits = ord(c) - 0x2800
                for dx, dy, bit in DOTS:
                    if bits & bit:
                        px, py = X + 2 + dx * 6, Y + 3 + dy * 6
                        d.ellipse([px, py, px + 4, py + 4], fill=f)
            elif c != ' ':
                d.text((X, Y + 2), c, font=font, fill=f)
    img.save(path)


if __name__ == '__main__':
    figure, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    alone = penguin_cells(figure)
    scene = scene_cells(alone)
    for stem, grid in (('scene', scene), ('penguin', alone)):
        for suffix, mode in (('.ansi', 'true'), ('-256.ansi', '256'), ('.txt', 'plain')):
            with open(os.path.join(out, stem + suffix), 'w', encoding='utf-8') as f:
                f.write(render(grid, mode))
    if len(sys.argv) > 3:
        preview(scene, sys.argv[3])
    print(f'scene {WIDTH}×{LINES}, penguin {P_COLS}×{P_LINES} → {out}')
