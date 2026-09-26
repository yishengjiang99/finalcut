#!/usr/bin/env python3
"""Compose FinalCap App Store screenshots: caption on top, raw capture below.

Reads raw simulator captures plus docs/asc/screenshot-captions.json and writes
framed PNGs to docs/asc/screenshots/, named the way
.github/scripts/upload_finalcap_asc.py expects:

    iphone69-NN-<slug>.png  1320x2868  (APP_IPHONE_67)
    ipad13-NN-<slug>.png    2064x2752  (APP_IPAD_PRO_3GEN_129, only if iPad raws exist)

Setup (Linux or macOS, Python 3.9+):

    pip install pillow

Run from the repo root:

    python3 scripts/asc/compose_screenshots.py

Options:
    --raw DIR          raw frames directory (default: docs/asc/screenshots-raw)
    --captions FILE    captions JSON (default: docs/asc/screenshot-captions.json)
    --out DIR          output directory (default: docs/asc/screenshots)
    --build12          use each frame's "caption_build12" where present

Every output is checked for exact pixel size, RGB mode and no transparency;
any mismatch exits non-zero. Stale iphone69-*/ipad13-* files in --out that this
run did not write are removed so the uploader never picks up an old frame.
Font: Inter Bold (SIL OFL 1.1, scripts/asc/fonts/OFL.txt).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install pillow")

REPO = Path(__file__).resolve().parents[2]
FONT_PATH = Path(__file__).resolve().parent / "fonts" / "Inter-Bold.ttf"

DEVICES = {
    # key in captions JSON -> output prefix, exact App Store canvas size
    "raw_iphone": ("iphone69", (1320, 2868)),
    "raw_ipad": ("ipad13", (2064, 2752)),
}

BG_TOP = (0x0B, 0x0B, 0x0C)
BG_BOTTOM = (0x16, 0x16, 0x1A)
TEXT = (0xF5, 0xF5, 0xF7)
BORDER = (0x2A, 0x2A, 0x30)
BORDER_PX = 2

# Layout, as fractions of the canvas.
FONT_K = 0.0442  # font px = FONT_K * sqrt(W*H): 86 px on 1320x2868, ~105 px on 2064x2752
LINE_HEIGHT = 1.16  # x font size
TOP_MARGIN = 0.07  # of canvas height, to the top of the caption block
GAP = 0.035  # of canvas height, caption block -> screenshot
BOTTOM_MARGIN = 0.035  # of canvas height
SIDE_MARGIN = 0.08  # of canvas width, minimum on each side
CORNER = 0.05  # of the scaled screenshot width
SS = 4  # supersampling for anti-aliased masks


def fail(msg: str) -> None:
    sys.exit(f"ERROR: {msg}")


def gradient(size: tuple[int, int]) -> Image.Image:
    w, h = size
    col = Image.new("RGB", (1, h))
    px = col.load()
    for y in range(h):
        t = y / (h - 1)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
    return col.resize((w, h), Image.NEAREST)


def split_balanced(caption: str) -> list[str]:
    """Two lines with the smallest length difference (one line if a single word)."""
    words = caption.split()
    if len(words) < 2:
        return [caption]
    best = None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        # prefer the shorter line on top when equal-ish, like a headline
        score = (abs(len(a) - len(b)), len(a) > len(b))
        if best is None or score < best[0]:
            best = (score, [a, b])
    return best[1]


def rounded_mask(size: tuple[int, int], radius: float) -> Image.Image:
    w, h = size
    big = Image.new("L", (w * SS, h * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, w * SS - 1, h * SS - 1), radius=radius * SS, fill=255
    )
    return big.resize((w, h), Image.LANCZOS)


def compose(raw: Image.Image, caption: str, size: tuple[int, int], font_path: Path) -> Image.Image:
    W, H = size
    canvas = gradient(size).convert("RGBA")

    # Caption
    font_px = round(FONT_K * math.sqrt(W * H))
    max_text_w = W * (1 - 2 * SIDE_MARGIN)
    lines = split_balanced(caption)
    while True:
        font = ImageFont.truetype(str(font_path), font_px)
        widths = [font.getlength(line) for line in lines]
        if max(widths) <= max_text_w:
            break
        font_px -= 2
        if font_px < 40:
            fail(f"caption {caption!r} does not fit on two lines")
    line_h = round(font_px * LINE_HEIGHT)
    ascent, descent = font.getmetrics()
    top = round(H * TOP_MARGIN)
    draw = ImageDraw.Draw(canvas)
    # Always reserve two lines so the screenshot sits at the same spot on every frame.
    block_h = line_h * 2
    first_baseline = top + (line_h + ascent - descent) // 2
    if len(lines) == 1:
        first_baseline += line_h // 2
    for i, line in enumerate(lines):
        draw.text((W / 2, first_baseline + i * line_h), line, font=font, fill=TEXT, anchor="ms")

    # Screenshot area
    area_top = top + block_h + round(H * GAP)
    area_h = H - area_top - round(H * BOTTOM_MARGIN)
    area_w = W - 2 * round(W * SIDE_MARGIN)
    rw, rh = raw.size
    scale = min(area_w / rw, area_h / rh)
    sw, sh = round(rw * scale), round(rh * scale)
    x = (W - sw) // 2
    y = area_top + (area_h - sh) // 2
    radius = CORNER * sw

    # Soft drop shadow
    blur = round(0.035 * sw)
    pad = blur * 3
    shadow = Image.new("RGBA", (sw + 2 * pad, sh + 2 * pad), (0, 0, 0, 0))
    smask = Image.new("L", shadow.size, 0)
    ImageDraw.Draw(smask).rounded_rectangle(
        (pad, pad, pad + sw, pad + sh), radius=radius, fill=190
    )
    shadow.putalpha(smask.filter(ImageFilter.GaussianBlur(blur)))
    canvas.alpha_composite(shadow, (x - pad, y - pad + round(0.012 * H)))

    # 2 px hairline border (a ring just outside the screenshot)
    b = BORDER_PX
    ring = Image.new("RGBA", (sw + 2 * b, sh + 2 * b), BORDER + (255,))
    ring.putalpha(rounded_mask(ring.size, radius + b))
    canvas.alpha_composite(ring, (x - b, y - b))

    # Screenshot with rounded corners
    shot = raw.convert("RGB").resize((sw, sh), Image.LANCZOS).convert("RGBA")
    shot.putalpha(rounded_mask((sw, sh), radius))
    canvas.alpha_composite(shot, (x, y))

    print(
        f"    font {font_px}px, lines {lines}, shot {sw}x{sh} at ({x},{y}), "
        f"side margin {x / W:.1%}, radius {radius:.0f}px"
    )
    return canvas.convert("RGB")


def validate(path: Path, size: tuple[int, int]) -> None:
    with Image.open(path) as im:
        im.load()
        problems = []
        if im.size != size:
            problems.append(f"size {im.size[0]}x{im.size[1]}, need {size[0]}x{size[1]}")
        if im.mode != "RGB":
            problems.append(f"mode {im.mode}, need RGB (no alpha)")
        if "transparency" in im.info:
            problems.append("has a tRNS transparency chunk")
        if im.format != "PNG":
            problems.append(f"format {im.format}, need PNG")
    if problems:
        fail(f"{path}: " + "; ".join(problems))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--raw", type=Path, default=REPO / "docs/asc/screenshots-raw")
    ap.add_argument("--captions", type=Path, default=REPO / "docs/asc/screenshot-captions.json")
    ap.add_argument("--out", type=Path, default=REPO / "docs/asc/screenshots")
    ap.add_argument("--build12", action="store_true", help='use "caption_build12" where present')
    ap.add_argument("--font", type=Path, default=FONT_PATH)
    args = ap.parse_args()

    if not args.font.is_file():
        fail(f"font not found: {args.font}")
    spec = json.loads(args.captions.read_text(encoding="utf-8"))
    frames = sorted(spec["frames"], key=lambda f: f["index"])
    if [f["index"] for f in frames] != list(range(1, len(frames) + 1)):
        fail("frame indexes must be 1..N with no gaps")
    for f in frames:
        if not f.get("slug") or not f.get("caption"):
            fail(f"frame {f['index']} needs a slug and a caption")

    args.out.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for raw_key, (prefix, size) in DEVICES.items():
        if not any(f.get(raw_key) for f in frames):
            print(f"skip {prefix}: no {raw_key} frames listed")
            continue
        for f in frames:
            name = f.get(raw_key)
            if not name:
                fail(f"frame {f['index']} has no {raw_key}; list one for every frame or none")
            src = args.raw / name
            if not src.is_file():
                fail(f"missing raw frame {src}")
            caption = f.get("caption_build12") if args.build12 and f.get("caption_build12") else f["caption"]
            dst = args.out / f"{prefix}-{f['index']:02d}-{f['slug']}.png"
            print(f"{dst.name}  <-  {name}  \"{caption}\"")
            with Image.open(src) as raw:
                raw.load()
                if abs(raw.size[0] / raw.size[1] - size[0] / size[1]) > 0.01:
                    print(f"    warning: {name} is {raw.size[0]}x{raw.size[1]}, not the {prefix} aspect ratio")
                out = compose(raw, caption, size, args.font)
            out.save(dst, "PNG", optimize=True)
            validate(dst, size)
            written.append(dst)

    for prefix, _ in DEVICES.values():
        for old in args.out.glob(f"{prefix}-*.png"):
            if old not in written:
                print(f"removing stale {old}")
                old.unlink()

    print(f"OK: {len(written)} screenshots in {args.out}, all exact size, RGB, no alpha")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
