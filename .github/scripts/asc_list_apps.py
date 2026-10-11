"""GET-only inventory of every app in the App Store Connect account.

Signs a short-lived JWT from the API key in env (never printed) and dumps,
per app: identity, newest appStoreVersion, latest build, availability,
price and IAP/subscriptions. Prints JSON between ASC_APPS_JSON_BEGIN/END.
No POST/PATCH/DELETE calls are made.
"""
import json, os, time, urllib.request, urllib.error, urllib.parse
import jwt

BASE = "https://api.appstoreconnect.apple.com"
p8 = os.environ["APP_STORE_CONNECT_API_KEY_P8"].replace("\\n", "\n").strip()
now = int(time.time())
TOKEN = jwt.encode({"iss": os.environ["APP_STORE_CONNECT_ISSUER_ID"].strip(), "iat": now,
                    "exp": now + 1200, "aud": "appstoreconnect-v1"},
                   p8, algorithm="ES256", headers={"kid": os.environ["APP_STORE_CONNECT_KEY_ID"].strip()})
del p8


def get(path):
    url = path if path.startswith("http") else BASE + path
    req = urllib.request.Request(url, method="GET", headers={"Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode() or "{}")


def get_all(path, cap=2000):
    data, included = [], []
    nxt = path
    while nxt and len(data) < cap:
        j = get(nxt)
        d = j.get("data")
        if isinstance(d, list):
            data.extend(d)
        elif d is not None:
            return j
        included.extend(j.get("included", []))
        nxt = (j.get("links") or {}).get("next")
    return {"data": data, "included": included}


def safe(fn):
    try:
        return fn()
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode())
            errs = [{"status": x.get("status"), "code": x.get("code"), "detail": x.get("detail")} for x in body.get("errors", [])]
        except Exception:
            errs = []
        return {"_error": f"HTTP {e.code}", "_errors": errs}
    except Exception as e:  # noqa
        return {"_error": type(e).__name__ + ": " + str(e)[:200]}


def lookup(app_id):
    try:
        with urllib.request.urlopen(f"https://itunes.apple.com/lookup?id={app_id}&country=us", timeout=30) as r:
            res = json.loads(r.read().decode()).get("results", [])
        if not res:
            return {"found": False}
        x = res[0]
        return {"found": True, **{k: x.get(k) for k in ("version", "releaseDate", "currentVersionReleaseDate",
                                                        "minimumOsVersion", "formattedPrice", "price", "trackName")}}
    except Exception as e:  # noqa
        return {"_error": str(e)[:200]}


apps = get_all("/v1/apps?limit=200&fields[apps]=name,bundleId,sku,primaryLocale")["data"]
out = []
for a in apps:
    aid = a["id"]
    at = a["attributes"]
    rec = {"id": aid, "name": at.get("name"), "bundleId": at.get("bundleId"), "sku": at.get("sku"),
           "primaryLocale": at.get("primaryLocale")}

    def infos():
        return [{"id": i["id"], "state": i["attributes"].get("state"), "appStoreState": i["attributes"].get("appStoreState"),
                 "appStoreAgeRating": i["attributes"].get("appStoreAgeRating")}
                for i in get(f"/v1/apps/{aid}/appInfos")["data"]]
    rec["appInfos"] = safe(infos)

    def versions():
        vs = get_all(f"/v1/apps/{aid}/appStoreVersions?limit=200&include=build"
                     "&fields[appStoreVersions]=versionString,platform,appStoreState,appVersionState,createdDate,earliestReleaseDate,releaseType,build"
                     "&fields[builds]=version,uploadedDate,minOsVersion,processingState,expired")
        builds = {b["id"]: b["attributes"] for b in vs["included"] if b["type"] == "builds"}
        res = []
        for v in vs["data"]:
            x = dict(v["attributes"]); x["id"] = v["id"]
            bid = ((v.get("relationships") or {}).get("build") or {}).get("data")
            if bid:
                x["build"] = builds.get(bid["id"])
            res.append(x)
        res.sort(key=lambda x: x.get("createdDate") or "", reverse=True)
        return res
    rec["versions"] = safe(versions)

    def latest_build():
        j = get(f"/v1/builds?filter[app]={aid}&sort=-uploadedDate&limit=1&include=buildBundles"
                "&fields[builds]=version,uploadedDate,minOsVersion,processingState,expired,buildBundles"
                "&fields[buildBundles]=sdkBuild,platformBuild,bundleType,bundleId")
        if not j["data"]:
            return None
        b = j["data"][0]
        x = dict(b["attributes"]); x["id"] = b["id"]
        x["bundles"] = [bb["attributes"] for bb in j.get("included", []) if bb["type"] == "buildBundles"]
        return x
    rec["latestBuild"] = safe(latest_build)

    def reviews():
        j = get(f"/v1/reviewSubmissions?filter[app]={aid}&limit=10&fields[reviewSubmissions]=platform,submittedDate,state")
        return [dict(r["attributes"], id=r["id"]) for r in j["data"]]
    rec["reviewSubmissions"] = safe(reviews)

    def availability():
        av = get(f"/v1/apps/{aid}/appAvailabilityV2")["data"]
        terr = get_all(f"/v2/appAvailabilities/{av['id']}/territoryAvailabilities?limit=200"
                       "&fields[territoryAvailabilities]=available,releaseDate,preOrderEnabled,contentStatuses")["data"]
        avail = [t for t in terr if t["attributes"].get("available")]
        statuses = {}
        for t in terr:
            for s in t["attributes"].get("contentStatuses") or []:
                statuses[s] = statuses.get(s, 0) + 1
        rel = sorted({t["attributes"].get("releaseDate") for t in terr if t["attributes"].get("releaseDate")})
        return {"availableInNewTerritories": av["attributes"].get("availableInNewTerritories"),
                "territoriesTotal": len(terr), "territoriesAvailable": len(avail),
                "contentStatusCounts": statuses, "releaseDates": rel[:5]}
    rec["availability"] = safe(availability)

    def price():
        ps = get(f"/v1/apps/{aid}/appPriceSchedule?include=baseTerritory")
        base = [t["id"] for t in ps.get("included", []) if t["type"] == "territories"]
        sid = ps["data"]["id"]
        mp = get(f"/v1/appPriceSchedules/{sid}/manualPrices?include=appPricePoint,territory&limit=50"
                 "&fields[appPricePoints]=customerPrice,proceeds")
        pts = {p["id"]: p["attributes"] for p in mp.get("included", []) if p["type"] == "appPricePoints"}
        prices = []
        for m in mp["data"]:
            rel = m.get("relationships") or {}
            pp = (rel.get("appPricePoint") or {}).get("data") or {}
            tt = (rel.get("territory") or {}).get("data") or {}
            prices.append({"territory": tt.get("id"), "startDate": m["attributes"].get("startDate"),
                           "endDate": m["attributes"].get("endDate"), **(pts.get(pp.get("id")) or {})})
        return {"baseTerritory": base[0] if base else None, "manualPrices": prices[:10]}
    rec["price"] = safe(price)

    def iaps():
        j = get_all(f"/v1/apps/{aid}/inAppPurchasesV2?limit=200&fields[inAppPurchases]=name,productId,inAppPurchaseType,state")
        return [dict(i["attributes"], id=i["id"]) for i in j["data"]]
    rec["inAppPurchases"] = safe(iaps)

    def subs():
        j = get_all(f"/v1/apps/{aid}/subscriptionGroups?limit=50&include=subscriptions"
                    "&fields[subscriptions]=name,productId,state,subscriptionPeriod")
        groups = [{"id": g["id"], "referenceName": g["attributes"].get("referenceName")} for g in j["data"]]
        s = [dict(x["attributes"], id=x["id"]) for x in j["included"] if x["type"] == "subscriptions"]
        return {"groups": groups, "subscriptions": s}
    rec["subscriptions"] = safe(subs)

    rec["publicLookupUS"] = lookup(aid)
    out.append(rec)

print("ASC_APPS_JSON_BEGIN")
print(json.dumps(out, indent=1, ensure_ascii=False))
print("ASC_APPS_JSON_END")
