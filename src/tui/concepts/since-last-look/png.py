"""
Paints one ANSI frame from render.ts as a terminal screenshot, for when vhs cannot
capture frames (its headless browser renders nothing in some sandboxes).

  FORCE_COLOR=3 bun run src/tui/concepts/since-last-look/render.ts 80 24 > frame.ansi
  python3 src/tui/concepts/since-last-look/png.py frame.ansi out.png 80 24
"""
import re
import sys
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

FONTS = '/usr/share/fonts/TTF/CaskaydiaMonoNerdFontMono-{}.ttf'
FALLBACK = ['/usr/share/fonts/TTF/DejaVuSansMono.ttf', '/usr/share/fonts/noto/NotoSansSymbols-Regular.ttf',
            '/usr/share/fonts/noto/NotoSansMath-Regular.ttf', '/usr/share/fonts/noto/NotoSansSymbols2-Regular.ttf']
SIZE = 16
PAD = 14

# Catppuccin Mocha, the theme the vhs tapes ask for.
BG = (30, 30, 46)
FG = (205, 214, 244)
PALETTE = {
    30: (69, 71, 90), 31: (243, 139, 168), 32: (166, 227, 161), 33: (249, 226, 175),
    34: (137, 180, 250), 35: (245, 194, 231), 36: (148, 226, 213), 37: (186, 194, 222),
    90: (108, 112, 134), 91: (243, 139, 168), 92: (166, 227, 161), 93: (249, 226, 175),
    94: (137, 180, 250), 95: (245, 194, 231), 96: (148, 226, 213), 97: (166, 173, 200),
}


def load(style):
    return ImageFont.truetype(FONTS.format(style), SIZE)


def main(src, out, cols, rows):
    regular, bold, italic = load('Regular'), load('Bold'), load('Italic')
    def cmap(path):
        return set(TTFont(path, lazy=True).getBestCmap())

    covered = cmap(FONTS.format('Regular'))
    fallbacks = []
    for path in FALLBACK:
        try:
            fallbacks.append((ImageFont.truetype(path, SIZE), cmap(path)))
        except OSError:
            pass
    ascent, descent = regular.getmetrics()
    cw = round(regular.getlength('M'))
    ch = ascent + descent + 3

    def font_for(c, base):
        if ord(c) in covered:
            return base
        for f, points in fallbacks:
            if ord(c) in points:
                return f
        return base

    text = re.sub(r'\x1b\[[0-9;?]*[A-LN-Za-ln-z]', '', open(src, encoding='utf8').read())
    lines = text.split('\n')[:rows]
    img = Image.new('RGB', (cols * cw + 2 * PAD, rows * ch + 2 * PAD), BG)
    draw = ImageDraw.Draw(img)
    token = re.compile(r'\x1b\[([0-9;]*)m')
    for y, line in enumerate(lines):
        fg, is_bold, is_italic, inverse = None, False, False, False
        x = 0
        pos = 0
        for match in list(token.finditer(line)) + [None]:
            chunk = line[pos:match.start()] if match else line[pos:]
            for c in chunk:
                if x >= cols:
                    break
                color = fg or FG
                px, py = PAD + x * cw, PAD + y * ch
                if inverse:
                    draw.rectangle([px, py, px + cw - 1, py + ch - 1], fill=color)
                    color = BG
                base = bold if is_bold else italic if is_italic else regular
                if c in '█▉▊▋▌▍▎▏':
                    eighths = '█▉▊▋▌▍▎▏'.index(c)
                    w = round(cw * (8 - eighths) / 8)
                    draw.rectangle([px, py + 1, px + w - 1, py + ch - 2], fill=color)
                elif c != ' ':
                    draw.text((px, py + 2), c, font=font_for(c, base), fill=color)
                x += 1
            if not match:
                break
            pos = match.end()
            codes = [int(v) for v in match.group(1).split(';') if v] or [0]
            i = 0
            while i < len(codes):
                code = codes[i]
                if code == 0:
                    fg, is_bold, is_italic, inverse = None, False, False, False
                elif code == 1:
                    is_bold = True
                elif code == 3:
                    is_italic = True
                elif code == 7:
                    inverse = True
                elif code == 22:
                    is_bold = False
                elif code == 23:
                    is_italic = False
                elif code == 27:
                    inverse = False
                elif code == 39:
                    fg = None
                elif code in PALETTE:
                    fg = PALETTE[code]
                elif code == 38 and i + 2 < len(codes) and codes[i + 1] == 5:
                    i += 2
                i += 1
    img.save(out)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
