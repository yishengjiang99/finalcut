#!/usr/bin/env python3
"""Check ASO copy: Apple limits + keyword hygiene for docs/asc/metadata/en-US (upload-ready,
fastlane deliver layout). Also: LISTING.md fenced blocks must equal metadata/en-US, the
upload-ready files must not contain banned/unshipped phrases, and every screenshot hero-text
line must stay short. Exit 1 on any failure.
Usage: python3 docs/asc/check_copy.py
"""
from __future__ import annotations
import re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
META = HERE / "metadata" / "en-US"
FIELDS = [("name", "Name", 30), ("subtitle", "Subtitle", 30), ("keywords", "Keywords", 100),
          ("promotional_text", "Promotional text", 170), ("description", "Description", 4000)]
PENDING = [r"coming soon", r"unreleased", r"beta feature"]
BANNED = ["grok", "final cut"]
errors: list[str] = []


def blocks(md: Path, pat: str) -> dict[str, str]:
    return {m.group(1).strip(): m.group(2).strip()
            for m in re.finditer(pat, md.read_text(), re.S | re.M)}


def words(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", s.lower())}


def check_keywords(tag: str, kw: str, name: str, subtitle: str) -> None:
    if ", " in kw or kw != kw.strip():
        errors.append(f"{tag} keywords: space after comma / padding")
    items = kw.split(",")
    low = [k.lower() for k in items]
    if any(not k for k in low):
        errors.append(f"{tag} keywords: empty item")
    if len(set(low)) != len(low):
        errors.append(f"{tag} keywords: duplicate item")
    taken = words(name) | words(subtitle)
    for k in low:
        dup = words(k) & taken
        if dup:
            errors.append(f"{tag} keywords: {k!r} repeats name/subtitle word {sorted(dup)}")
        if k.endswith("s") and k[:-1] in low:
            errors.append(f"{tag} keywords: plural {k!r} duplicates singular")


def table(tag: str, vals: dict[str, str]) -> None:
    print(f"{tag}")
    print(f"  {'field':<18}{'chars':>6}{'limit':>7}  ok")
    for key, label, lim in FIELDS:
        n = len(vals[key])
        ok = n <= lim
        if not ok:
            errors.append(f"{tag} {label}: {n} > {lim}")
        print(f"  {label:<18}{n:>6}{lim:>7}  {'yes' if ok else 'NO'}")
    blob = " ".join(vals.values()).lower()
    for b in BANNED:
        if b in blob:
            errors.append(f"{tag}: mentions {b!r}")
    check_keywords(tag, vals["keywords"], vals["name"], vals["subtitle"])


def main() -> int:
    up = {k: (META / f"{k}.txt").read_text().strip() for k, _, _ in FIELDS}
    table("upload-ready (metadata/en-US)", up)
    blob = " ".join(up.values()).lower()
    for p in PENDING:
        if re.search(p, blob):
            errors.append(f"upload-ready: pending phrase {p!r}")

    listing = blocks(HERE / "LISTING.md", r"^## ([^\n(]+?)(?: \(\d+.*?\))?\n```\n(.*?)```")
    for key, label, _ in FIELDS:
        if listing.get(label) != up[key]:
            errors.append(f"LISTING.md {label} != metadata/en-US/{key}.txt")

    print("\nscreenshot hero text (<= 5 words per line)")
    sys.path.insert(0, str(HERE / "screenshots" / "en-US"))
    from make_store_screenshots import SHOTS
    for slug, hero, _sub, _user, _assistant in SHOTS:
        for line in hero.split("\n"):
            n = len(line.split())
            if n > 5:
                errors.append(f"hero line {line!r} ({slug}): {n} words")
            print(f"  {n} words  {slug}: {line}")

    print()
    for e in errors:
        print("FAIL", e)
    print("OK" if not errors else f"{len(errors)} failure(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
