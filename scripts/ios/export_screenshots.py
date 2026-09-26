#!/usr/bin/env python3
"""Export ScreenshotTests PNG attachments from an .xcresult, verify size, rename, flatten alpha.

usage: export_screenshots.py <bundle.xcresult> <out_dir> <prefix> <WIDTHxHEIGHT>

Attachments are named "NN-<slug>" by FinalCutUITests/ScreenshotTests.swift. Output files are
<out_dir>/<prefix>-NN-<slug>.png. Exits non-zero unless all six frames exist at the exact size.
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

EXPECTED = ["01-editor", "02-edit-card", "03-compare", "04-title", "05-color-look", "06-export"]


def png_info(path):
    with open(path, "rb") as f:
        head = f.read(33)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    w, h, depth, ctype = struct.unpack(">IIBB", head[16:26])
    return w, h, depth, ctype


def flatten_png(path):
    """Rewrite as opaque RGB (App Store frames must not carry alpha). Needs Pillow."""
    from PIL import Image

    with Image.open(path) as im:
        im.load()
        info = {k: v for k, v in im.info.items() if k in ("icc_profile", "dpi")}
        rgb = im.convert("RGB")
    rgb.save(path, "PNG", optimize=True, **info)
    return True


def main():
    bundle, out_dir, prefix, size = sys.argv[1:5]
    want_w, want_h = (int(x) for x in size.lower().split("x"))
    os.makedirs(out_dir, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="xcattach-")
    subprocess.check_call(["xcrun", "xcresulttool", "export", "attachments", "--path", bundle, "--output-path", tmp])
    manifest = json.load(open(os.path.join(tmp, "manifest.json")))
    found = {}
    for test in manifest:
        for att in test.get("attachments", []):
            human = att.get("suggestedHumanReadableName", "")
            m = re.match(r"(\d\d-[a-z0-9-]+?)(?:_\d+)?(?:_[0-9A-F-]{36})?(?:\.png)?$", human)
            slug = m.group(1) if m else None
            if slug not in EXPECTED:
                m2 = next((e for e in EXPECTED if human.startswith(e)), None)
                slug = m2
            if slug:
                found[slug] = os.path.join(tmp, att["exportedFileName"])
    errors = []
    for slug in EXPECTED:
        src = found.get(slug)
        if not src:
            errors.append(f"missing attachment {slug}")
            continue
        dst = os.path.join(out_dir, f"{prefix}-{slug}.png")
        shutil.copyfile(src, dst)
        w, h, depth, ctype = png_info(dst)
        if ctype == 6:
            flatten_png(dst)
            w, h, depth, ctype = png_info(dst)
        status = "OK" if (w, h) == (want_w, want_h) else "WRONG SIZE"
        print(f"{status} {os.path.basename(dst)} {w}x{h} colortype={ctype}")
        if (w, h) != (want_w, want_h):
            errors.append(f"{dst}: {w}x{h}, expected {want_w}x{want_h}")
    if errors:
        print("manifest:", json.dumps(manifest, indent=1)[:4000])
        sys.exit("\n".join(errors))


if __name__ == "__main__":
    main()
