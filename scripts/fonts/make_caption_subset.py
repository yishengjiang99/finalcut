#!/usr/bin/env python3
"""Build the caption font subset the in-browser caption burn (WebCodecs + canvas) loads as a FontFace.

Input : public/fonts/NotoSansSC-Regular.ttf (10.1 MB, static Regular instance)
Output: public/fonts/NotoSansSC-Subset.ttf  (about 2.5 MB: Latin/Greek/Cyrillic, punctuation, kana,
        GB2312 level 1 + symbols, Big5 common traditional, JIS level 1 kanji)

Run: python3 scripts/fonts/make_caption_subset.py   (needs fonttools: pip install fonttools)
"""
import os
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'public', 'fonts', 'NotoSansSC-Regular.ttf')
OUT = os.path.join(ROOT, 'public', 'fonts', 'NotoSansSC-Subset.ttf')


def decode_range(codec, rows, cols):
    out = set()
    for r in rows:
        for c in cols:
            try:
                ch = bytes([r, c]).decode(codec)
            except Exception:
                continue
            if len(ch) == 1:
                out.add(ord(ch))
    return out


gb_l1 = decode_range('gb2312', range(0xB0, 0xD8), range(0xA1, 0xFF))
gb_sym = decode_range('gb2312', range(0xA1, 0xAA), range(0xA1, 0xFF))
big5 = decode_range('big5', range(0xA4, 0xC7), list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)))
jis1 = decode_range('shift_jis', range(0x88, 0x99), list(range(0x40, 0x7F)) + list(range(0x80, 0xFD)))
base = set()
for lo, hi in [(0x20, 0x24F), (0x370, 0x52F), (0x1E00, 0x1EFF), (0x2000, 0x206F), (0x20A0, 0x20BF),
               (0x2100, 0x21FF), (0x3000, 0x30FF), (0x31F0, 0x31FF), (0xFF00, 0xFFEF)]:
    base |= set(range(lo, hi + 1))
wanted = base | gb_l1 | gb_sym | big5 | jis1

opts = subset.Options()
opts.layout_features = []
opts.hinting = False
opts.desubroutinize = True
opts.notdef_outline = True
opts.name_IDs = ['*']
font = TTFont(SRC)
sub = subset.Subsetter(opts)
sub.populate(unicodes=sorted(wanted))
sub.subset(font)
font.save(OUT)

print(len(TTFont(OUT).getBestCmap()), 'glyphs;', os.path.getsize(OUT), 'bytes')
