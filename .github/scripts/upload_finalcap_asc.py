#!/usr/bin/env python3
"""Upload FinalCap (Apple ID 6815060815) listing + screenshots to ASC."""
from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import jwt

APPLE_ID = os.environ.get("APP_APPLE_ID", "6815060815").strip()
BUNDLE_HINT = "com.ragnus.w2"
SHOT_DIR = Path(os.environ.get("SHOT_DIR", "docs/asc/screenshots"))

LISTING_JSON = Path(os.environ.get("LISTING_JSON", "docs/asc/listing.en-US.json"))
UPLOAD_SCREENSHOTS = os.environ.get("UPLOAD_SCREENSHOTS", "false").strip().lower() == "true"

_L = json.loads(LISTING_JSON.read_text(encoding="utf-8"))
NAME = _L["name"]
SUBTITLE = _L["subtitle"]
PROMO = _L["promotionalText"]
DESCRIPTION = _L["description"]
KEYWORDS = _L["keywords"]
SUPPORT_URL = _L["supportUrl"]
MARKETING_URL = _L["marketingUrl"]
PRIVACY_URL = _L["privacyPolicyUrl"]

for _field, _value, _limit in (
    ("name", NAME, 30),
    ("subtitle", SUBTITLE, 30),
    ("keywords", KEYWORDS, 100),
    ("promotionalText", PROMO, 170),
    ("description", DESCRIPTION, 4000),
):
    if len(_value) > _limit:
        raise SystemExit(f"{_field} is {len(_value)} chars, limit {_limit}")


def token() -> str:
    key_id = os.environ["APP_STORE_CONNECT_KEY_ID"].strip()
    issuer = os.environ["APP_STORE_CONNECT_ISSUER_ID"].strip()
    p8 = os.environ["APP_STORE_CONNECT_API_KEY_P8"].replace("\\n", "\n").strip()
    print(f"ASC auth key_id={key_id} issuer={issuer}")
    now = int(time.time())
    return jwt.encode(
        {"iss": issuer, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
        p8,
        algorithm="ES256",
        headers={"kid": key_id},
    )


TOK = None


def api(method: str, path: str, body=None):
    global TOK
    if TOK is None:
        TOK = token()
    data = None if body is None else json.dumps(body).encode()
    headers = {"Authorization": f"Bearer {TOK}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        "https://api.appstoreconnect.apple.com" + path,
        data=data,
        method=method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode() or "{}"
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        raise SystemExit(f"{method} {path} -> {e.code}: {err[:3000]}")


def put_bytes(url: str, method: str, headers: dict, chunk: bytes):
    req = urllib.request.Request(url, data=chunk, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=180) as r:
        r.read()


def main():
    # Find app
    st, apps = api("GET", f"/v1/apps?filter[id]={APPLE_ID}&limit=5")
    app = apps.get("data", [None])[0]
    if not app:
        st, apps = api("GET", "/v1/apps?limit=200")
        for a in apps.get("data", []):
            print("APP_CAND", a["id"], a["attributes"].get("bundleId"), a["attributes"].get("name"))
            if a["id"] == APPLE_ID or a["attributes"].get("bundleId") == BUNDLE_HINT:
                app = a
                break
    if not app:
        raise SystemExit(f"App {APPLE_ID} / {BUNDLE_HINT} not found for this API key")
    app_id = app["id"]
    print("APP", app_id, app["attributes"].get("bundleId"), app["attributes"].get("name"))

    # Version 1.0 iOS
    st, vers = api("GET", f"/v1/apps/{app_id}/appStoreVersions?filter[platform]=IOS&limit=20")
    version = None
    for v in vers.get("data", []):
        print(
            "VERSION",
            v["id"],
            v["attributes"].get("versionString"),
            v["attributes"].get("appStoreState"),
        )
        if v["attributes"].get("versionString") == "1.0":
            version = v
    if version is None:
        st, created = api(
            "POST",
            "/v1/appStoreVersions",
            {
                "data": {
                    "type": "appStoreVersions",
                    "attributes": {"platform": "IOS", "versionString": "1.0"},
                    "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
                }
            },
        )
        version = created["data"]
        print("created version", version["id"])
    version_id = version["id"]

    # en-US localization
    st, locs = api("GET", f"/v1/appStoreVersions/{version_id}/appStoreVersionLocalizations")
    loc = next((L for L in locs.get("data", []) if L["attributes"].get("locale") == "en-US"), None)
    if loc is None:
        st, created = api(
            "POST",
            "/v1/appStoreVersionLocalizations",
            {
                "data": {
                    "type": "appStoreVersionLocalizations",
                    "attributes": {"locale": "en-US"},
                    "relationships": {
                        "appStoreVersion": {"data": {"type": "appStoreVersions", "id": version_id}}
                    },
                }
            },
        )
        loc = created["data"]
    loc_id = loc["id"]
    api(
        "PATCH",
        f"/v1/appStoreVersionLocalizations/{loc_id}",
        {
            "data": {
                "type": "appStoreVersionLocalizations",
                "id": loc_id,
                "attributes": {
                    "description": DESCRIPTION,
                    "keywords": KEYWORDS,
                    "marketingUrl": MARKETING_URL,
                    "promotionalText": PROMO,
                    "supportUrl": SUPPORT_URL,
                    # whatsNew is not editable on the first App Store version
                },
            }
        },
    )
    print("localization patched", loc_id)

    # App name / subtitle
    st, infos = api("GET", f"/v1/apps/{app_id}/appInfos")
    if infos.get("data"):
        info_id = infos["data"][0]["id"]
        st, info_locs = api("GET", f"/v1/appInfos/{info_id}/appInfoLocalizations")
        info_loc = next(
            (L for L in info_locs.get("data", []) if L["attributes"].get("locale") == "en-US"),
            None,
        )
        attrs = {
            "name": NAME,
            "subtitle": SUBTITLE,
            "privacyPolicyUrl": PRIVACY_URL,
        }
        if info_loc is None:
            api(
                "POST",
                "/v1/appInfoLocalizations",
                {
                    "data": {
                        "type": "appInfoLocalizations",
                        "attributes": {"locale": "en-US", **attrs},
                        "relationships": {"appInfo": {"data": {"type": "appInfos", "id": info_id}}},
                    }
                },
            )
            print("created appInfoLocalization")
        else:
            api(
                "PATCH",
                f"/v1/appInfoLocalizations/{info_loc['id']}",
                {
                    "data": {
                        "type": "appInfoLocalizations",
                        "id": info_loc["id"],
                        "attributes": attrs,
                    }
                },
            )
            print("patched appInfoLocalization", info_loc["id"])

    # Screenshot sets (only when asked, so a text-only run never wipes existing shots)
    if not UPLOAD_SCREENSHOTS:
        print("SUCCESS FinalCap ASC listing text uploaded (screenshots skipped)")
        return
    if not SHOT_DIR.is_dir():
        raise SystemExit(f"Missing screenshot dir {SHOT_DIR.resolve()}")

    mapping = {
        # 6.9" iPhone (1320x2868) uses the APP_IPHONE_67 display type.
        "APP_IPHONE_67": sorted(SHOT_DIR.glob("iphone69-*.png")),
        # 13" iPad (2064x2752) uses the APP_IPAD_PRO_3GEN_129 display type.
        "APP_IPAD_PRO_3GEN_129": sorted(SHOT_DIR.glob("ipad13-*.png")),
    }
    st, sets = api("GET", f"/v1/appStoreVersionLocalizations/{loc_id}/appScreenshotSets")
    by_type = {s["attributes"]["screenshotDisplayType"]: s for s in sets.get("data", [])}

    for dtype, files in mapping.items():
        if not files:
            print("skip empty", dtype)
            continue
        sset = by_type.get(dtype)
        if sset is None:
            st, created = api(
                "POST",
                "/v1/appScreenshotSets",
                {
                    "data": {
                        "type": "appScreenshotSets",
                        "attributes": {"screenshotDisplayType": dtype},
                        "relationships": {
                            "appStoreVersionLocalization": {
                                "data": {"type": "appStoreVersionLocalizations", "id": loc_id}
                            }
                        },
                    }
                },
            )
            sset = created["data"]
            print("created set", dtype, sset["id"])
        else:
            print("reuse set", dtype, sset["id"])
            st, old = api("GET", f"/v1/appScreenshotSets/{sset['id']}/appScreenshots")
            for sh in old.get("data", []):
                api("DELETE", f"/v1/appScreenshots/{sh['id']}")
                print("deleted", sh["id"])

        for path in files:
            raw = path.read_bytes()
            st, reserved = api(
                "POST",
                "/v1/appScreenshots",
                {
                    "data": {
                        "type": "appScreenshots",
                        "attributes": {"fileName": path.name, "fileSize": len(raw)},
                        "relationships": {
                            "appScreenshotSet": {
                                "data": {"type": "appScreenshotSets", "id": sset["id"]}
                            }
                        },
                    }
                },
            )
            shot = reserved["data"]
            shot_id = shot["id"]
            for op in shot["attributes"].get("uploadOperations") or []:
                headers = {h["name"]: h["value"] for h in op.get("requestHeaders", [])}
                offset = int(op.get("offset", 0))
                length = int(op.get("length", len(raw)))
                put_bytes(op["url"], op["method"], headers, raw[offset : offset + length])
            st, committed = api(
                "PATCH",
                f"/v1/appScreenshots/{shot_id}",
                {
                    "data": {
                        "type": "appScreenshots",
                        "id": shot_id,
                        "attributes": {
                            "uploaded": True,
                            "sourceFileChecksum": hashlib.md5(raw).hexdigest(),
                        },
                    }
                },
            )
            state = committed["data"]["attributes"].get("assetDeliveryState")
            print("shot", path.name, shot_id, state)

    print("SUCCESS FinalCap ASC listing + screenshots uploaded")


if __name__ == "__main__":
    main()
