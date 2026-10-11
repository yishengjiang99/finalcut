"""Remove an explicit allowlist of old apps (and their IAPs) from sale.

Approved by the account owner on 2026-10-10 for exactly the six app ids in
ALLOWED_APPS. Any other id is refused. Never deletes an app ("Remove App").
Secrets are only used to sign the JWT and are never printed.
"""
import json, os, sys, time, urllib.request, urllib.error
import jwt

ALLOWED_APPS = {
    "642101022": "Free Instant Alerts for NASDAQ",
    "644641252": "Projectile Motion",
    "644782348": "Projectile Motion Free Edition",
    "648179171": "Slide Puzzle with Adorable Puppies",
    "755182884": "Photo Contest",
    "875994803": "GodSec",
}
ALLOWED_IAPS = {  # iap id -> owning app id
    "643478252": "642101022", "642177230": "642101022", "644851856": "642101022",
    "648182046": "648179171", "648200817": "648179171",
}
PROTUNE = "6813991381"  # read back only, never written

requested = [x.strip() for x in os.environ.get("APP_IDS", "").replace(",", " ").split() if x.strip()]
if not requested:
    requested = list(ALLOWED_APPS)
bad = [x for x in requested if x not in ALLOWED_APPS]
if bad:
    print(f"REFUSED: ids not in allowlist: {bad}")
    sys.exit(2)

BASE = "https://api.appstoreconnect.apple.com"
p8 = os.environ["APP_STORE_CONNECT_API_KEY_P8"].replace("\\n", "\n").strip()
_now = int(time.time())
TOKEN = jwt.encode({"iss": os.environ["APP_STORE_CONNECT_ISSUER_ID"].strip(), "iat": _now,
                    "exp": _now + 1200, "aud": "appstoreconnect-v1"},
                   p8, algorithm="ES256", headers={"kid": os.environ["APP_STORE_CONNECT_KEY_ID"].strip()})
del p8
CURRENT = {"app": None}


def req(method, path, body=None):
    if method != "GET":
        assert CURRENT["app"] in ALLOWED_APPS, "write outside allowlisted app context"
        assert PROTUNE not in path
    url = path if path.startswith("http") else BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, method=method, data=data,
                               headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(r, timeout=90) as resp:
                txt = resp.read().decode()
                return resp.status, (json.loads(txt) if txt else {})
        except urllib.error.HTTPError as e:
            txt = e.read().decode()
            if e.code == 429 and attempt < 3:
                time.sleep(10 * (attempt + 1)); continue
            try:
                errs = [{k: x.get(k) for k in ("status", "code", "title", "detail")} for x in json.loads(txt).get("errors", [])]
            except Exception:
                errs = [txt[:300]]
            return e.code, {"errors": errs}


def get(path):
    s, j = req("GET", path)
    if s >= 400:
        raise RuntimeError(f"GET {path.split('?')[0]} -> {s} {j.get('errors')}")
    return j


def get_all(path):
    data, nxt = [], path
    while nxt:
        j = get(nxt)
        data.extend(j.get("data", []))
        nxt = (j.get("links") or {}).get("next")
    return data


def territories(app_id):
    av = get(f"/v1/apps/{app_id}/appAvailabilityV2")["data"]
    terr = get_all(f"/v2/appAvailabilities/{av['id']}/territoryAvailabilities?limit=200"
                   "&fields[territoryAvailabilities]=available,contentStatuses")
    return av, terr


def summarize_app(app_id):
    out = {"id": app_id}
    try:
        infos = get(f"/v1/apps/{app_id}/appInfos")["data"]
        out["appInfoStates"] = [i["attributes"].get("appStoreState") or i["attributes"].get("state") for i in infos]
        vs = get(f"/v1/apps/{app_id}/appStoreVersions?limit=5&fields[appStoreVersions]=versionString,appStoreState,createdDate")["data"]
        vs.sort(key=lambda v: v["attributes"].get("createdDate") or "", reverse=True)
        out["versionState"] = vs[0]["attributes"].get("appStoreState") if vs else None
        av, terr = territories(app_id)
        st = {}
        for t in terr:
            for c in t["attributes"].get("contentStatuses") or []:
                st[c] = st.get(c, 0) + 1
        out.update(availableInNewTerritories=av["attributes"].get("availableInNewTerritories"),
                   territoriesTotal=len(terr),
                   territoriesAvailable=sum(1 for t in terr if t["attributes"].get("available")),
                   contentStatusCounts=st)
    except Exception as e:  # noqa
        out["_error"] = str(e)[:400]
    return out


def iap_summary(iap_id):
    out = {"id": iap_id}
    try:
        a = get(f"/v2/inAppPurchases/{iap_id}?fields[inAppPurchases]=name,productId,state")["data"]["attributes"]
        out.update(name=a.get("name"), productId=a.get("productId"), state=a.get("state"))
        s, j = req("GET", f"/v2/inAppPurchases/{iap_id}/inAppPurchaseAvailability")
        if s >= 400:
            out["availability"] = {"status": s, "errors": j.get("errors")}
        else:
            aid = j["data"]["id"]
            terrs = get_all(f"/v1/inAppPurchaseAvailabilities/{aid}/availableTerritories?limit=200")
            out["availability"] = {"availableInNewTerritories": j["data"]["attributes"].get("availableInNewTerritories"),
                                   "availableTerritories": len(terrs)}
    except Exception as e:  # noqa
        out["_error"] = str(e)[:400]
    return out


report = {"before": {}, "actions": {}, "after": {}, "iaps": {}}
for app_id in requested:
    CURRENT["app"] = None
    report["before"][app_id] = summarize_app(app_id)
    act = {"name": ALLOWED_APPS[app_id]}
    CURRENT["app"] = app_id
    try:
        av, terr = territories(app_id)
        ok, fail, errs = 0, 0, []
        for t in terr:
            if not t["attributes"].get("available"):
                continue
            s, j = req("PATCH", f"/v1/territoryAvailabilities/{t['id']}",
                       {"data": {"type": "territoryAvailabilities", "id": t["id"], "attributes": {"available": False}}})
            if s < 400:
                ok += 1
            else:
                fail += 1
                if len(errs) < 3:
                    errs.append({"status": s, "errors": j.get("errors")})
            time.sleep(0.05)
        act["v2_territory_patch"] = {"ok": ok, "failed": fail, "sampleErrors": errs}

        # availableInNewTerritories=false: there is no documented PATCH on appAvailabilities;
        # try the only documented write (POST /v2/appAvailabilities) once and report.
        if av["attributes"].get("availableInNewTerritories"):
            s, j = req("POST", "/v2/appAvailabilities", {"data": {
                "type": "appAvailabilities", "attributes": {"availableInNewTerritories": False},
                "relationships": {"app": {"data": {"type": "apps", "id": app_id}},
                                  "territoryAvailabilities": {"data": []}}}})
            act["availableInNewTerritories_false"] = {"status": s, "errors": j.get("errors") if s >= 400 else None}

        if ok == 0 and fail > 0:
            s, j = req("PATCH", f"/v1/apps/{app_id}", {"data": {"type": "apps", "id": app_id,
                                                             "relationships": {"availableTerritories": {"data": []}}}})
            act["legacy_v1_apps_patch"] = {"status": s, "errors": j.get("errors") if s >= 400 else None}
    except Exception as e:  # noqa
        act["_error"] = str(e)[:400]

    # IAPs owned by this app that are on the allowlist
    try:
        iaps = get_all(f"/v1/apps/{app_id}/inAppPurchasesV2?limit=200&fields[inAppPurchases]=name,productId,state")
        for i in iaps:
            iid = i["id"]
            if ALLOWED_IAPS.get(iid) != app_id:
                act.setdefault("skippedIaps", []).append(iid)
                continue
            s, j = req("POST", "/v1/inAppPurchaseAvailabilities", {"data": {
                "type": "inAppPurchaseAvailabilities", "attributes": {"availableInNewTerritories": False},
                "relationships": {"inAppPurchase": {"data": {"type": "inAppPurchases", "id": iid}},
                                  "availableTerritories": {"data": []}}}})
            rec = {"status": s, "errors": j.get("errors") if s >= 400 else None}
            if s >= 400:
                s2, j2 = req("PATCH", f"/v2/inAppPurchases/{iid}", {"data": {"type": "inAppPurchases", "id": iid,
                                                                       "attributes": {"availableInAllTerritories": False}}})
                rec["legacy_patch_availableInAllTerritories"] = {"status": s2, "errors": j2.get("errors") if s2 >= 400 else None}
            act.setdefault("iapActions", {})[iid] = rec
    except Exception as e:  # noqa
        act["iap_error"] = str(e)[:400]
    CURRENT["app"] = None
    report["actions"][app_id] = act

time.sleep(5)
for app_id in requested:
    report["after"][app_id] = summarize_app(app_id)
for iid, owner in ALLOWED_IAPS.items():
    if owner in requested:
        report["iaps"][iid] = iap_summary(iid)
report["protune_readonly"] = summarize_app(PROTUNE)

for section in ("before", "actions", "after", "iaps"):
    for k, v in report[section].items():
        print(f"RFS_{section.upper()} {k} " + json.dumps(v, separators=(",", ":")))
print("RFS_PROTUNE " + json.dumps(report["protune_readonly"], separators=(",", ":")))
print("RFS_END")
