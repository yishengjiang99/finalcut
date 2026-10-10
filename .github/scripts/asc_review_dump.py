#!/usr/bin/env python3
"""GET-only dump of App Store review state for one app (no writes).

Collects review submissions + items, app store versions (build, review
detail, legacy submission), app infos, subscription groups/subscriptions
(state, review note, review screenshot), IAPs, and probes for any
resolution-center / rejection endpoints. Writes raw JSON to $OUT. Secrets
are only used to sign the JWT and are never printed.
"""
import json, os, time, urllib.error, urllib.request
import jwt

APP = os.environ["APP_ID"]
p8 = os.environ["APP_STORE_CONNECT_API_KEY_P8"].replace("\\n", "\n").strip()
now = int(time.time())
TOKEN = jwt.encode({"iss": os.environ["APP_STORE_CONNECT_ISSUER_ID"].strip(), "iat": now, "exp": now + 1200,
                    "aud": "appstoreconnect-v1"}, p8, algorithm="ES256",
                   headers={"kid": os.environ["APP_STORE_CONNECT_KEY_ID"].strip()})
dump = {}

def get(path):
    req = urllib.request.Request("https://api.appstoreconnect.apple.com" + path, method="GET",
                                 headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.loads(r.read().decode() or "{}")
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            body = json.loads(e.read().decode() or "{}")
        except Exception:
            body = {}
    except Exception as e:
        status, body = -1, {"_exception": str(e)[:300]}
    dump[path] = {"status": status, "body": body}
    print(status, path)
    return body if 200 <= status < 300 else {}

ids = lambda b: [d["id"] for d in (b.get("data") or [])] if isinstance(b.get("data"), list) else ([b["data"]["id"]] if b.get("data") else [])

get(f"/v1/apps/{APP}")
get(f"/v1/apps/{APP}/appInfos")
subs = get(f"/v1/apps/{APP}/reviewSubmissions?limit=50&include=items,appStoreVersionForReview,submittedByActor,lastUpdatedByActor")
for sid in ids(subs):
    get(f"/v1/reviewSubmissions/{sid}")
    get(f"/v1/reviewSubmissions/{sid}/items?limit=50&include=appStoreVersion,appCustomProductPageVersion,appStoreVersionExperiment,appEvent")
    get(f"/v1/resolutionCenterThreads?filter[reviewSubmission]={sid}")
    get(f"/v1/reviewSubmissions/{sid}/resolutionCenterThreads")
vers = get(f"/v1/apps/{APP}/appStoreVersions?filter[platform]=IOS&limit=10")
for vid in ids(vers):
    get(f"/v1/appStoreVersions/{vid}?include=build,appStoreReviewDetail,appStoreVersionSubmission")
    get(f"/v1/appStoreVersions/{vid}/build")
    get(f"/v1/appStoreVersions/{vid}/appStoreReviewDetail")
    get(f"/v1/appStoreVersions/{vid}/appStoreVersionSubmission")
    get(f"/v1/appStoreVersions/{vid}/appStoreVersionPhasedRelease")
    get(f"/v1/appStoreVersions/{vid}/customerReviews?limit=1")
groups = get(f"/v1/apps/{APP}/subscriptionGroups?limit=20&include=subscriptions")
for gid in ids(groups):
    get(f"/v1/subscriptionGroups/{gid}/subscriptionGroupLocalizations")
    sb = get(f"/v1/subscriptionGroups/{gid}/subscriptions?limit=50")
    for s in ids(sb):
        get(f"/v1/subscriptions/{s}")
        get(f"/v1/subscriptions/{s}/subscriptionLocalizations")
        get(f"/v1/subscriptions/{s}/appStoreReviewScreenshot")
        get(f"/v1/subscriptions/{s}/subscriptionAvailability")
        get(f"/v1/subscriptions/{s}/introductoryOffers?limit=5")
iaps = get(f"/v1/apps/{APP}/inAppPurchasesV2?limit=50")
for i in ids(iaps):
    get(f"/v2/inAppPurchases/{i}")
    get(f"/v2/inAppPurchases/{i}/appStoreReviewScreenshot")
# Probes for rejection / resolution-center data (expected 404 on the public API)
for path in [f"/v1/apps/{APP}/resolutionCenterThreads", "/v1/resolutionCenterThreads",
             "/v1/reviewRejections", f"/v1/apps/{APP}/reviewRejections",
             f"/v1/apps/{APP}/appStoreVersionSubmissions"]:
    get(path)
json.dump(dump, open(os.environ["OUT"], "w"), indent=2, ensure_ascii=False)
