#!/usr/bin/env python3
"""Create (idempotently) the 'FinalCap Pro' auto-renewable subscription for
FinalCap - AI Video Editor (com.ragnus.w2, ASC app 6815060815) via the App Store Connect API.

Finds existing objects and creates only what is missing:
  subscription group 'FinalCap Pro' + en-US group localization
  com.ragnus.w2.subscription.monthly  'FinalCap Pro Monthly'  ONE_MONTH  USD 9.99  level 1  no trial
  en-US subscription localization, availability in all territories (+ new territories),
  prices in every territory equalized from the USA price point, Family Sharing off,
  App Review note, and the App Store review screenshot docs/asc/review/subscription-paywall.png
  (replaced when the committed file's md5 differs). Writes are skipped once the subscription is
  WAITING_FOR_REVIEW / IN_REVIEW / APPROVED.

Never submits anything for review. VERIFY_ONLY=true does read-only verification.
Product IDs must match ios/FinalCut/Features/Paywall/StoreKitPurchaseStub.swift and ios/FinalCut/StoreKit/FinalCut.storekit.
Env: APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID, APP_STORE_CONNECT_API_KEY_P8,
     BUNDLE_ID (com.ragnus.w2), VERIFY_ONLY (true/false)
"""
from __future__ import annotations
import hashlib, os, sys, time
from pathlib import Path
import jwt, requests

BASE = "https://api.appstoreconnect.apple.com"
BUNDLE_ID = os.environ.get("BUNDLE_ID", "com.ragnus.w2").strip()
VERIFY_ONLY = os.environ.get("VERIFY_ONLY", "false").strip().lower() == "true"
LOCALE = "en-US"
ROOT = Path(__file__).resolve().parents[2]
REVIEW_SHOT = Path(os.environ.get("REVIEW_SCREENSHOT", ROOT / "docs/asc/review/subscription-paywall.png"))
GROUP_REF = "FinalCap Pro"
GROUP_DISPLAY = "FinalCap Pro"
REVIEW_NOTE = ("FinalCap Pro Monthly is an auto-renewable subscription ($9.99/month in the US) that unlocks "
               "unlimited AI edits, captions and translations. To reach the paywall: launch FinalCap and tap the "
               "crown 'Upgrade' button at the top right of the editor. The paywall shows the price and period from "
               "StoreKit, Restore Purchases, Terms of Use (Apple standard EULA) and the Privacy Policy. "
               "Sandbox purchases work with any sandbox Apple ID. Contact: Yisheng Jiang, yisheng.jiang@gmail.com, "
               "+1 669 251 7789.")
PRODUCTS = [
    {"productId": "com.ragnus.w2.subscription.monthly", "name": "FinalCap Pro Monthly", "level": 1,
     "period": "ONE_MONTH", "usd": "9.99", "desc": "Unlimited AI edits, captions and translations"},
]
_tok = {"v": None, "t": 0}


def token() -> str:
    now = int(time.time())
    if _tok["v"] and now - _tok["t"] < 600:
        return _tok["v"]
    p8 = os.environ["APP_STORE_CONNECT_API_KEY_P8"].replace("\\n", "\n").strip()
    _tok["v"] = jwt.encode({"iss": os.environ["APP_STORE_CONNECT_ISSUER_ID"].strip(), "iat": now,
                            "exp": now + 1100, "aud": "appstoreconnect-v1"}, p8, algorithm="ES256",
                           headers={"kid": os.environ["APP_STORE_CONNECT_KEY_ID"].strip()})
    _tok["t"] = now
    return _tok["v"]


class ApiError(Exception):
    pass


def api(method, path, body=None, ok404=False):
    assert method == "GET" or "Submission" not in path, "this script never submits"
    if VERIFY_ONLY and method != "GET":
        raise SystemExit(f"VERIFY_ONLY but tried {method} {path}")
    for attempt in range(5):
        r = requests.request(method, path if path.startswith("http") else BASE + path, json=body,
                             headers={"Authorization": "Bearer " + token()}, timeout=120)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 4:
            time.sleep(3 * (attempt + 1))
            continue
        break
    if ok404 and r.status_code == 404:
        return None
    if r.status_code >= 300:
        raise ApiError(f"{method} {path} -> {r.status_code}: {r.text[:3000]}")
    return r.json() if r.text else {}


def get_all(path):
    out, inc, url = [], [], path
    while url:
        j = api("GET", url)
        d = j.get("data")
        out.extend(d if isinstance(d, list) else ([d] if d else []))
        inc.extend(j.get("included", []))
        url = (j.get("links") or {}).get("next")
    return out, inc


def rel(t, i):
    return {"data": {"type": t, "id": i}}


def create(t, attrs, rels):
    print(f"CREATE {t} {attrs}")
    return api("POST", f"/v1/{t}", {"data": {"type": t, "attributes": attrs, "relationships": rels}})["data"]


def ensure_group(app_id):
    groups, _ = get_all(f"/v1/apps/{app_id}/subscriptionGroups?limit=200")
    g = None
    for grp in groups:  # prefer the group that already holds our product
        subs, _ = get_all(f"/v1/subscriptionGroups/{grp['id']}/subscriptions?limit=200")
        if any(s["attributes"]["productId"] in {p["productId"] for p in PRODUCTS} for s in subs):
            g = grp
            break
    g = g or next((g for g in groups if g["attributes"]["referenceName"] == GROUP_REF), None)
    if g:
        print("FOUND group", g["id"], g["attributes"]["referenceName"])
    else:
        g = create("subscriptionGroups", {"referenceName": GROUP_REF}, {"app": rel("apps", app_id)})
    locs, _ = get_all(f"/v1/subscriptionGroups/{g['id']}/subscriptionGroupLocalizations?limit=200")
    loc = next((l for l in locs if l["attributes"]["locale"] == LOCALE), None)
    if loc:
        print("FOUND group localization", loc["id"], loc["attributes"].get("name"), loc["attributes"].get("state"))
    else:
        create("subscriptionGroupLocalizations", {"locale": LOCALE, "name": GROUP_DISPLAY},
               {"subscriptionGroup": rel("subscriptionGroups", g["id"])})
    return g, groups


def ensure_sub(group_id, all_groups, p):
    # look in every group of the app so a product created elsewhere is not duplicated
    for grp in all_groups + [{"id": group_id}]:
        subs, _ = get_all(f"/v1/subscriptionGroups/{grp['id']}/subscriptions?limit=200")
        s = next((s for s in subs if s["attributes"]["productId"] == p["productId"]), None)
        if s:
            if grp["id"] != group_id:
                print(f"WARNING {p['productId']} exists in another group {grp['id']}")
            print("FOUND subscription", s["id"], p["productId"], s["attributes"].get("state"))
            a = s["attributes"]
            if a.get("familySharable"):
                print(f"WARNING {p['productId']} has Family Sharing ON (Apple does not allow turning it off)")
            return s
    return create("subscriptions", {"productId": p["productId"], "name": p["name"],
                                    "subscriptionPeriod": p["period"], "familySharable": False},
                  {"group": rel("subscriptionGroups", group_id)})


def ensure_sub_loc(sub_id, p):
    locs, _ = get_all(f"/v1/subscriptions/{sub_id}/subscriptionLocalizations?limit=200")
    loc = next((l for l in locs if l["attributes"]["locale"] == LOCALE), None)
    if loc:
        print("FOUND subscription localization", loc["id"], loc["attributes"].get("name"))
        return
    create("subscriptionLocalizations", {"locale": LOCALE, "name": p["name"], "description": p["desc"]},
           {"subscription": rel("subscriptions", sub_id)})


def ensure_review_note(sub_id, p):
    cur = api("GET", f"/v1/subscriptions/{sub_id}")["data"]["attributes"]
    if (cur.get("reviewNote") or "") == REVIEW_NOTE and cur.get("name") == p["name"]:
        print("FOUND review note", p["productId"])
        return
    print("SET review note / name", p["productId"])
    api("PATCH", f"/v1/subscriptions/{sub_id}", {"data": {"type": "subscriptions", "id": sub_id,
                                                          "attributes": {"reviewNote": REVIEW_NOTE, "name": p["name"]}}})


def ensure_availability(sub_id, territory_ids):
    j = api("GET", f"/v1/subscriptions/{sub_id}/subscriptionAvailability", ok404=True)
    if j and j.get("data"):
        av = j["data"]
        cur, _ = get_all(f"/v1/subscriptionAvailabilities/{av['id']}/availableTerritories?limit=200")
        have = {t["id"] for t in cur}
        missing = set(territory_ids) - have
        print("FOUND availability", av["id"], len(have), "territories; missing", len(missing),
              "availableInNewTerritories=", av["attributes"].get("availableInNewTerritories"))
        if not missing and av["attributes"].get("availableInNewTerritories"):
            return
    print("SET availability:", len(territory_ids), "territories")
    api("POST", "/v1/subscriptionAvailabilities", {"data": {
        "type": "subscriptionAvailabilities", "attributes": {"availableInNewTerritories": True},
        "relationships": {"subscription": rel("subscriptions", sub_id),
                          "availableTerritories": {"data": [{"type": "territories", "id": t} for t in sorted(territory_ids)]}}}})


def usa_price_point(sub_id, usd):
    pts, _ = get_all(f"/v1/subscriptions/{sub_id}/pricePoints?filter[territory]=USA&limit=200")
    for pp in pts:
        if pp["attributes"]["customerPrice"] in (usd, usd + "0") or float(pp["attributes"]["customerPrice"]) == float(usd):
            return pp
    raise SystemExit(f"no USA price point {usd} for {sub_id}")


def existing_prices(sub_id):
    prices, inc = get_all(f"/v1/subscriptions/{sub_id}/prices?include=territory,subscriptionPricePoint&limit=200")
    pp = {i["id"]: i["attributes"] for i in inc if i["type"] == "subscriptionPricePoints"}
    out = {}
    for pr in prices:
        terr = ((pr.get("relationships") or {}).get("territory") or {}).get("data")
        ppd = ((pr.get("relationships") or {}).get("subscriptionPricePoint") or {}).get("data")
        if terr:
            out[terr["id"]] = (pp.get(ppd["id"], {}).get("customerPrice") if ppd else None, pr["attributes"].get("startDate"))
    return out


def ensure_prices(sub_id, p):
    base = usa_price_point(sub_id, p["usd"])
    eq, eq_inc = get_all(f"/v1/subscriptionPricePoints/{base['id']}/equalizations?include=territory&limit=200")
    targets = {"USA": base["id"]}
    for e in eq:
        terr = ((e.get("relationships") or {}).get("territory") or {}).get("data")
        if terr:
            targets[terr["id"]] = e["id"]
    have = existing_prices(sub_id)
    todo = {t: ppid for t, ppid in targets.items() if t not in have}
    print(f"PRICES {p['productId']}: USA point {base['id']} = {base['attributes']['customerPrice']}; "
          f"{len(targets)} territories, {len(have)} already priced, {len(todo)} to create")
    # USA first so a failure (e.g. agreements) surfaces immediately
    for t in sorted(todo, key=lambda x: (x != "USA", x)):
        api("POST", "/v1/subscriptionPrices", {"data": {
            "type": "subscriptionPrices", "attributes": {"preserveCurrentPrice": False},
            "relationships": {"subscription": rel("subscriptions", sub_id),
                              "subscriptionPricePoint": rel("subscriptionPricePoints", todo[t]),
                              "territory": rel("territories", t)}}})
    if todo:
        print(f"PRICES {p['productId']}: created {len(todo)}")


def ensure_levels(subs):
    """subs: {productId: subscription id}. Yearly level 1 (highest), monthly level 2."""
    for p in sorted(PRODUCTS, key=lambda p: p["level"]):
        sid = subs[p["productId"]]
        cur = api("GET", f"/v1/subscriptions/{sid}")["data"]["attributes"].get("groupLevel")
        if cur == p["level"]:
            print("FOUND level", p["productId"], cur)
            continue
        print(f"SET level {p['productId']}: {cur} -> {p['level']}")
        api("PATCH", f"/v1/subscriptions/{sid}", {"data": {"type": "subscriptions", "id": sid,
                                                            "attributes": {"groupLevel": p["level"]}}})


def ensure_review_screenshot(sub_id, product_id):
    if not REVIEW_SHOT.exists():
        print(f"WARNING review screenshot {REVIEW_SHOT} not in repo; skipping upload")
        return
    data = REVIEW_SHOT.read_bytes()
    md5 = hashlib.md5(data).hexdigest()
    j = api("GET", f"/v1/subscriptions/{sub_id}/appStoreReviewScreenshot", ok404=True)
    cur = j.get("data") if j else None
    if cur:
        a = cur["attributes"]
        state = (a.get("assetDeliveryState") or {}).get("state")
        if a.get("sourceFileChecksum") == md5 and state in ("COMPLETE", "UPLOAD_COMPLETE"):
            print("FOUND review screenshot", product_id, cur["id"], state, "(same md5)")
            return
        print("DELETE review screenshot", product_id, cur["id"], state)
        api("DELETE", f"/v1/subscriptionAppStoreReviewScreenshots/{cur['id']}")
    res = create("subscriptionAppStoreReviewScreenshots", {"fileName": REVIEW_SHOT.name, "fileSize": len(data)},
                 {"subscription": rel("subscriptions", sub_id)})
    for op in res["attributes"]["uploadOperations"]:
        off, ln = op["offset"], op["length"]
        r = requests.request(op["method"], op["url"], data=data[off:off + ln],
                             headers={h["name"]: h["value"] for h in op.get("requestHeaders", [])}, timeout=120)
        if r.status_code >= 300:
            raise ApiError(f"upload part {off}+{ln} -> {r.status_code}: {r.text[:500]}")
    api("PATCH", f"/v1/subscriptionAppStoreReviewScreenshots/{res['id']}", {"data": {
        "type": "subscriptionAppStoreReviewScreenshots", "id": res["id"],
        "attributes": {"uploaded": True, "sourceFileChecksum": md5}}})
    for _ in range(40):
        a = api("GET", f"/v1/subscriptionAppStoreReviewScreenshots/{res['id']}")["data"]["attributes"]
        state = (a.get("assetDeliveryState") or {}).get("state")
        if state in ("COMPLETE", "FAILED"):
            break
        time.sleep(5)
    print("UPLOADED review screenshot", product_id, res["id"], state, a.get("assetDeliveryState"))
    if state != "COMPLETE":
        raise ApiError(f"review screenshot {product_id} state {state}: {a.get('assetDeliveryState')}")


def verify(app_id):
    print("\n===== VERIFY =====")
    ok = True
    n_all = len(get_all("/v1/territories?limit=200")[0])
    print("ALL TERRITORIES", n_all)
    groups, _ = get_all(f"/v1/apps/{app_id}/subscriptionGroups?limit=200")
    for g in groups:
        locs, _ = get_all(f"/v1/subscriptionGroups/{g['id']}/subscriptionGroupLocalizations?limit=200")
        print("GROUP", g["id"], repr(g["attributes"]["referenceName"]),
              [(l["attributes"]["locale"], l["attributes"].get("name"), l["attributes"].get("state")) for l in locs])
        try:
            gv = api("GET", f"/v1/subscriptionGroups/{g['id']}/versions?limit=50", ok404=True)
            print("  GROUP VERSIONS", None if gv is None else [(v["id"], v["attributes"]) for v in gv.get("data", [])])
        except ApiError as e:
            print("  GROUP VERSIONS error", str(e)[:300])
        subs, _ = get_all(f"/v1/subscriptionGroups/{g['id']}/subscriptions?limit=200")
        for s in subs:
            try:
                sv = api("GET", f"/v1/subscriptions/{s['id']}/versions?limit=50", ok404=True)
                print("  SUB VERSIONS", s["attributes"]["productId"], None if sv is None else [(v["id"], v["attributes"]) for v in sv.get("data", [])])
            except ApiError as e:
                print("  SUB VERSIONS error", str(e)[:300])
            a = s["attributes"]
            sl, _ = get_all(f"/v1/subscriptions/{s['id']}/subscriptionLocalizations?limit=200")
            prices = existing_prices(s["id"])
            av = api("GET", f"/v1/subscriptions/{s['id']}/subscriptionAvailability", ok404=True)
            nterr = 0
            if av and av.get("data"):
                t, _ = get_all(f"/v1/subscriptionAvailabilities/{av['data']['id']}/availableTerritories?limit=200")
                nterr = len(t)
            shot = api("GET", f"/v1/subscriptions/{s['id']}/appStoreReviewScreenshot", ok404=True)
            sd = (shot or {}).get("data")
            shot_desc = "MISSING"
            if sd:
                sa = sd["attributes"]
                shot_desc = (f"{sd['id']} {sa.get('fileName')} {sa.get('imageAsset', {}) and str(sa['imageAsset'].get('width'))+'x'+str(sa['imageAsset'].get('height'))} "
                             f"md5={sa.get('sourceFileChecksum')} delivery={(sa.get('assetDeliveryState') or {}).get('state')}")
            print(f"  SUB {s['id']} {a['productId']} name={a.get('name')!r} period={a.get('subscriptionPeriod')} "
                  f"state={a.get('state')} familySharable={a.get('familySharable')} level={a.get('groupLevel')}")
            print(f"      localizations={[(l['attributes']['locale'], l['attributes'].get('name'), l['attributes'].get('description'), l['attributes'].get('state')) for l in sl]}")
            print(f"      USA price={prices.get('USA')} priced_territories={len(prices)} available_territories={nterr} "
                  f"review_note={a.get('reviewNote')!r}")
            print(f"      review_screenshot={shot_desc}")
            want = next((p for p in PRODUCTS if p["productId"] == a["productId"]), None)
            if want and (not prices.get("USA") or float(prices["USA"][0]) != float(want["usd"])):
                print("      USA PRICE MISSING/WRONG")
                ok = False
            if want and (nterr < n_all or len(prices) < n_all):
                print(f"      TERRITORIES INCOMPLETE available={nterr} priced={len(prices)} (want {n_all})")
                ok = False
            if want and a.get("reviewNote") != REVIEW_NOTE:
                print("      REVIEW NOTE MISSING/STALE")
                ok = False
            if want and a.get("groupLevel") != want["level"]:
                print(f"      LEVEL MISMATCH want {want['level']}")
                ok = False
            if want and REVIEW_SHOT.exists() and "delivery=COMPLETE" not in shot_desc:
                print("      REVIEW SCREENSHOT NOT COMPLETE")
                ok = False
    found = {s["attributes"]["productId"] for g in groups
             for s in get_all(f"/v1/subscriptionGroups/{g['id']}/subscriptions?limit=200")[0]}
    for p in PRODUCTS:
        if p["productId"] not in found:
            print("MISSING product", p["productId"])
            ok = False
    return ok


def review_submissions(app_id):
    subs, _ = get_all(f"/v1/apps/{app_id}/reviewSubmissions?filter[platform]=IOS&limit=50")
    for rs in subs:
        a = rs["attributes"]
        if a.get("state") in ("COMPLETE",):
            continue
        items = api("GET", f"/v1/reviewSubmissions/{rs['id']}/items?limit=50", ok404=True) or {}
        print("REVIEW SUBMISSION", rs["id"], a.get("state"), a.get("submittedDate"),
              [(i["id"], i["attributes"].get("state"), list((i.get("relationships") or {}).keys())) for i in items.get("data", [])])


def main():
    apps = api("GET", f"/v1/apps?filter[bundleId]={BUNDLE_ID}")["data"]
    if not apps:
        raise SystemExit(f"app {BUNDLE_ID} not found")
    app_id = apps[0]["id"]
    print("APP", app_id, apps[0]["attributes"].get("name"))
    if not VERIFY_ONLY:
        terr, _ = get_all("/v1/territories?limit=200")
        territory_ids = [t["id"] for t in terr]
        print("TERRITORIES", len(territory_ids))
        g, groups = ensure_group(app_id)
        ids = {}
        for p in PRODUCTS:
            s = ensure_sub(g["id"], groups, p)
            ids[p["productId"]] = s["id"]
            if s["attributes"].get("state") in ("APPROVED", "WAITING_FOR_REVIEW", "IN_REVIEW"):
                print(f"SKIP writes for {p['productId']}: state {s['attributes'].get('state')}")
                continue
            ensure_sub_loc(s["id"], p)
            ensure_review_note(s["id"], p)
            ensure_availability(s["id"], territory_ids)
            ensure_prices(s["id"], p)
            ensure_review_screenshot(s["id"], p["productId"])
        ensure_levels(ids)
    ok = verify(app_id)
    review_submissions(app_id)
    if not ok:
        print("VERIFY FAILED: missing product, USA price, group level or review screenshot")
        sys.exit(1)
    print("VERIFY OK")


if __name__ == "__main__":
    try:
        main()
    except ApiError as e:
        msg = str(e)
        print("API ERROR:", msg)
        if "agreement" in msg.lower():
            print("BLOCKER: the Paid Apps Agreement appears not to be active (ASC > Business).")
        sys.exit(1)
