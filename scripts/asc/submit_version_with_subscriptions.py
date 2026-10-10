#!/usr/bin/env python3
"""Submit FinalCap (com.ragnus.w2) version VERSION_STRING with build BUILD_NUMBER for App Review in ONE
reviewSubmission together with the first subscription (Apple: the first auto-renewable subscription and its
group must ride with an app version; otherwise 409 FIRST_SUBSCRIPTION_MUST_BE_SUBMITTED_ON_VERSION).

Items: appStoreVersion + subscriptionGroupVersion ('FinalCap Pro') + subscriptionVersion per product.
Reuses an EMPTY READY_FOR_REVIEW iOS reviewSubmission when one exists (else creates one). If any item cannot
be added, nothing is submitted.

MODE:
  status      read-only: build, version (+attached build, review details), group, subscriptions, open submissions
  wait_build  read-only poll until build BUILD_NUMBER is VALID (30 min max)
  cancel      pull reviewSubmission CANCEL_SUBMISSION_ID from review, wait until version is editable
  submit      clear export compliance on the build if unset, attach the build, write review notes + contact,
              then create/reuse a reviewSubmission with version + group + subscription(s) and submit it.
              Refuses if another submission is already WAITING_FOR_REVIEW / IN_REVIEW.
Env: APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID, APP_STORE_CONNECT_API_KEY_P8,
     BUNDLE_ID, VERSION_STRING, BUILD_NUMBER, MODE, CANCEL_SUBMISSION_ID
"""
from __future__ import annotations
import json, os, sys, time
import jwt, requests

BASE = "https://api.appstoreconnect.apple.com"
BUNDLE_ID = os.environ.get("BUNDLE_ID", "com.ragnus.w2").strip()
VERSION_STRING = os.environ.get("VERSION_STRING", "1.0").strip()
BUILD_NUMBER = os.environ.get("BUILD_NUMBER", "").strip()
MODE = os.environ.get("MODE", "status").strip()
PRODUCT_IDS = ["com.ragnus.w2.subscription.monthly"]
SUB_DONE = {"WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED"}
DRAFT_STATES = ("PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "DEVELOPER_REJECTED", "REJECTED")
EDITABLE = ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "READY_FOR_REVIEW")
OPEN_SUBMISSION = ("WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES", "CANCELING")

CONTACT = {"contactFirstName": "Yisheng", "contactLastName": "Jiang", "contactPhone": "+1 669 251 7789",
           "contactEmail": "yisheng.jiang@gmail.com", "demoAccountRequired": False}
REVIEW_NOTES = """FinalCap is a chat-driven video editor. No sign-in or demo account is needed: the app opens straight into the editor.

HOW TO TRY IT
1. Launch FinalCap. Tap Import to pick a clip from Photos, or use the bundled sample clip.
2. Type a request in the chat, e.g. "cut the first three seconds", "add a title that says Day One" or "make it warmer". The edit renders on the iPhone and shows in the preview.
3. Tap Export to save the result to Photos or share it.

IN-APP PURCHASE (FinalCap Pro Monthly, com.ragnus.w2.subscription.monthly, auto-renewable, 1 month, $9.99 US)
- To reach the paywall: tap the crown "Upgrade" button at the top right of the editor. The paywall also opens automatically if the free daily edit limit is reached.
- The paywall shows the subscription title, the localized price and period from StoreKit, what it includes, Subscribe, Restore Purchases, the auto-renew terms, and working links to the Terms of Use (Apple standard EULA) and the Privacy Policy (https://grepawk.com/legal/privacy.html).
- Sandbox purchases work: Subscribe with any sandbox Apple ID; Restore Purchases restores the subscription. No external payment or website checkout is used in the app.

CONTACT
Yisheng Jiang, yisheng.jiang@gmail.com, +1 669 251 7789"""


def token():
    now = int(time.time())
    p8 = os.environ["APP_STORE_CONNECT_API_KEY_P8"].replace("\\n", "\n").strip()
    return jwt.encode({"iss": os.environ["APP_STORE_CONNECT_ISSUER_ID"].strip(), "iat": now, "exp": now + 1100,
                       "aud": "appstoreconnect-v1"}, p8, algorithm="ES256",
                      headers={"kid": os.environ["APP_STORE_CONNECT_KEY_ID"].strip()})


def api(method, path, body=None):
    if MODE not in ("submit", "cancel") and method != "GET":
        raise SystemExit(f"read-only mode but tried {method} {path}")
    for attempt in range(4):
        r = requests.request(method, path if path.startswith("http") else BASE + path, json=body,
                             headers={"Authorization": "Bearer " + token()}, timeout=90)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 3:
            time.sleep(5 * (attempt + 1))
            continue
        return r.status_code, (r.json() if r.text else {})


def must(method, path, body=None, ok=()):
    code, j = api(method, path, body)
    if code >= 300 and code not in ok:
        raise SystemExit(f"{method} {path} -> {code}: {json.dumps(j)[:2000]}")
    return j


def find_build(app_id):
    if not BUILD_NUMBER:
        return None
    bs = must("GET", f"/v1/builds?filter[app]={app_id}&filter[version]={BUILD_NUMBER}&limit=10")["data"]
    return next((b for b in bs if not b["attributes"].get("expired")), None)


def find_group(app_id):
    for g in must("GET", f"/v1/apps/{app_id}/subscriptionGroups?limit=50")["data"]:
        subs = must("GET", f"/v1/subscriptionGroups/{g['id']}/subscriptions?limit=50")["data"]
        if any(s["attributes"]["productId"] in PRODUCT_IDS for s in subs):
            return g, subs
    return None, []


def get_version(app_id):
    return must("GET", f"/v1/apps/{app_id}/appStoreVersions?filter[platform]=IOS&filter[versionString]={VERSION_STRING}")["data"][0]


def status(app_id):
    print("\n===== STATUS =====")
    b = find_build(app_id)
    print("BUILD", BUILD_NUMBER or "-", b and (b["id"], b["attributes"].get("processingState"),
          "usesNonExemptEncryption=", b["attributes"].get("usesNonExemptEncryption"), b["attributes"].get("uploadedDate")))
    for v in must("GET", f"/v1/apps/{app_id}/appStoreVersions?filter[platform]=IOS&limit=5")["data"]:
        a = v["attributes"]
        vb = (must("GET", f"/v1/appStoreVersions/{v['id']}/build").get("data") or {})
        print("VERSION", v["id"], a.get("versionString"), a.get("appStoreState"), a.get("appVersionState"),
              "build=", (vb.get("attributes") or {}).get("version"), vb.get("id"))
        rd = must("GET", f"/v1/appStoreVersions/{v['id']}/appStoreReviewDetail", ok=(404,)).get("data")
        if rd:
            ra = rd["attributes"]
            print("  REVIEW DETAIL", rd["id"], ra.get("contactFirstName"), ra.get("contactLastName"), ra.get("contactEmail"),
                  ra.get("contactPhone"), "notes_match=", (ra.get("notes") or "") == REVIEW_NOTES,
                  "notes_head=", repr((ra.get("notes") or "")[:120]))
    g, subs = find_group(app_id)
    if g:
        gv = must("GET", f"/v1/subscriptionGroups/{g['id']}/versions?limit=10", ok=(404,)).get("data") or []
        print("GROUP", g["id"], g["attributes"].get("referenceName"), [(x["id"], x["attributes"]) for x in gv])
        for s in subs:
            sv = must("GET", f"/v1/subscriptions/{s['id']}/versions?limit=10", ok=(404,)).get("data") or []
            print("SUB", s["id"], s["attributes"]["productId"], s["attributes"].get("state"),
                  [(x["id"], x["attributes"]) for x in sv])
    else:
        print("GROUP none holding", PRODUCT_IDS)
    for rs in must("GET", f"/v1/apps/{app_id}/reviewSubmissions?filter[platform]=IOS&limit=20")["data"]:
        a = rs["attributes"]
        if a.get("state") == "COMPLETE":
            continue
        items = must("GET", f"/v1/reviewSubmissions/{rs['id']}/items?limit=50")["data"]
        print("REVIEW SUBMISSION", rs["id"], a.get("state"), "submitted=", a.get("submittedDate"),
              [(it["attributes"].get("state"), {k: (v.get("data") or {}).get("id") for k, v in (it.get("relationships") or {}).items()
                                                if isinstance(v, dict) and v.get("data")}) for it in items])


def latest_version(versions):
    for v in sorted(versions, key=lambda v: -(v["attributes"].get("version") or 0)):
        return v
    return None


def add_item(rs_id, rel_name, rel_type, rel_id):
    code, j = api("POST", "/v1/reviewSubmissionItems", {"data": {
        "type": "reviewSubmissionItems",
        "relationships": {"reviewSubmission": {"data": {"type": "reviewSubmissions", "id": rs_id}},
                          rel_name: {"data": {"type": rel_type, "id": rel_id}}}}})
    blob = json.dumps(j)
    ok = code < 300 or "ALREADY" in blob.upper() or "DUPLICATE" in blob.upper()
    print(f"ADD ITEM {rel_name} {rel_id} -> {code}", (j.get("data") or {}).get("id") if code < 300 else blob[:2000])
    return ok


def prepare_version(ver, build):
    vid = ver["id"]
    if build["attributes"].get("usesNonExemptEncryption") is None:
        must("PATCH", f"/v1/builds/{build['id']}", {"data": {"type": "builds", "id": build["id"],
                                                             "attributes": {"usesNonExemptEncryption": False}}})
        print("EXPORT COMPLIANCE cleared on build", BUILD_NUMBER)
    elif build["attributes"].get("usesNonExemptEncryption") is not False:
        raise SystemExit("build declares non-exempt encryption; not submitting")
    vb = (must("GET", f"/v1/appStoreVersions/{vid}/build").get("data") or {})
    if vb.get("id") != build["id"]:
        must("PATCH", f"/v1/appStoreVersions/{vid}/relationships/build", {"data": {"type": "builds", "id": build["id"]}})
        print("ATTACHED build", BUILD_NUMBER, build["id"], "to version", VERSION_STRING, "(was", (vb.get("attributes") or {}).get("version"), ")")
    attrs = dict(CONTACT, notes=REVIEW_NOTES)
    rd = must("GET", f"/v1/appStoreVersions/{vid}/appStoreReviewDetail", ok=(404,)).get("data")
    if rd:
        must("PATCH", f"/v1/appStoreReviewDetails/{rd['id']}", {"data": {"type": "appStoreReviewDetails", "id": rd["id"], "attributes": attrs}})
    else:
        must("POST", "/v1/appStoreReviewDetails", {"data": {"type": "appStoreReviewDetails", "attributes": attrs,
             "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}})
    print("REVIEW NOTES + contact written")
    vb = (must("GET", f"/v1/appStoreVersions/{vid}/build").get("data") or {})
    if vb.get("id") != build["id"]:
        raise SystemExit("build attach did not stick")


def main():
    app_id = must("GET", f"/v1/apps?filter[bundleId]={BUNDLE_ID}")["data"][0]["id"]
    print("APP", app_id, BUNDLE_ID, "version", VERSION_STRING, "build", BUILD_NUMBER or "-", "mode", MODE)

    if MODE == "wait_build":
        for i in range(60):
            b = find_build(app_id)
            st = b and b["attributes"].get("processingState")
            print(f"build {BUILD_NUMBER} poll {i + 1}: {st}", b and b["attributes"].get("usesNonExemptEncryption"))
            if st == "VALID":
                return
            if st in ("FAILED", "INVALID"):
                raise SystemExit(f"build {BUILD_NUMBER} is {st}")
            time.sleep(30)
        raise SystemExit(f"build {BUILD_NUMBER} not VALID after 30 min")

    if MODE == "status":
        status(app_id)
        return

    if MODE == "cancel":
        rs_id = os.environ.get("CANCEL_SUBMISSION_ID", "").strip() or sys.exit("CANCEL_SUBMISSION_ID required")
        a = must("GET", f"/v1/reviewSubmissions/{rs_id}")["data"]["attributes"]
        print("SUBMISSION", rs_id, a.get("state"))
        if a.get("state") not in ("WAITING_FOR_REVIEW", "UNRESOLVED_ISSUES", "CANCELING"):
            raise SystemExit(f"submission {rs_id} is {a.get('state')}; not cancelling")
        if a.get("state") != "CANCELING":
            j = must("PATCH", f"/v1/reviewSubmissions/{rs_id}", {"data": {"type": "reviewSubmissions", "id": rs_id,
                                                                            "attributes": {"canceled": True}}})
            print("CANCEL requested ->", j["data"]["attributes"].get("state"))
        vs = st = None
        for i in range(60):
            code, j = api("GET", f"/v1/reviewSubmissions/{rs_id}")
            st = "GONE(404)" if code == 404 else j["data"]["attributes"].get("state")
            vs = get_version(app_id)["attributes"].get("appStoreState")
            print(f"poll {i + 1}: submission={st} version {VERSION_STRING}={vs}")
            if st not in ("CANCELING", "WAITING_FOR_REVIEW", "IN_REVIEW") and vs in ("DEVELOPER_REJECTED", "PREPARE_FOR_SUBMISSION"):
                print("RESULT pulled from review; version editable:", vs)
                break
            time.sleep(15)
        else:
            raise SystemExit(f"timed out: submission={st} version={vs}")
        status(app_id)
        return

    if MODE != "submit":
        raise SystemExit(f"unknown MODE {MODE}")

    # ---- submit ----
    for r in must("GET", f"/v1/apps/{app_id}/reviewSubmissions?filter[platform]=IOS&limit=50")["data"]:
        if r["attributes"].get("state") in OPEN_SUBMISSION:
            raise SystemExit(f"submission {r['id']} is {r['attributes'].get('state')}; refusing to submit again")
    build = find_build(app_id)
    if not build or build["attributes"].get("processingState") != "VALID":
        raise SystemExit(f"build {BUILD_NUMBER} not VALID: {build and build['attributes']}")
    ver = get_version(app_id)
    print("VERSION", ver["id"], ver["attributes"].get("appStoreState"))
    if ver["attributes"].get("appStoreState") not in EDITABLE:
        raise SystemExit(f"version state {ver['attributes'].get('appStoreState')} not submittable")

    g, subs = find_group(app_id)
    if not g:
        raise SystemExit("subscription group not found")
    by_pid = {s["attributes"]["productId"]: s for s in subs}
    sub_versions = []
    for pid in PRODUCT_IDS:
        s = by_pid.get(pid) or sys.exit(f"MISSING {pid}")
        state = s["attributes"].get("state")
        print("SUB", pid, s["id"], state)
        if state in SUB_DONE:
            continue
        if state != "READY_TO_SUBMIT":
            raise SystemExit(f"NOT READY {pid}: {state}")
        sv = latest_version(must("GET", f"/v1/subscriptions/{s['id']}/versions?limit=50", ok=(404,)).get("data") or [])
        print("  subscriptionVersion", sv and (sv["id"], sv["attributes"]))
        sub_versions.append((pid, s, sv))
    gv = latest_version(must("GET", f"/v1/subscriptionGroups/{g['id']}/versions?limit=50", ok=(404,)).get("data") or [])
    print("GROUP", g["id"], "VERSION", gv and (gv["id"], gv["attributes"]))

    prepare_version(ver, build)

    rss = must("GET", f"/v1/apps/{app_id}/reviewSubmissions?filter[platform]=IOS&limit=50")["data"]
    draft = None
    for r in rss:
        if r["attributes"].get("state") == "READY_FOR_REVIEW":
            n = len(must("GET", f"/v1/reviewSubmissions/{r['id']}/items?limit=50")["data"])
            print("READY_FOR_REVIEW submission", r["id"], "items=", n)
            if draft is None and n == 0:
                draft = r
    if draft:
        print("REUSE empty reviewSubmission", draft["id"])
    else:
        draft = must("POST", "/v1/reviewSubmissions", {"data": {"type": "reviewSubmissions", "attributes": {"platform": "IOS"},
                     "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}}})["data"]
        print("CREATED reviewSubmission", draft["id"])
    rs_id = draft["id"]

    ok = add_item(rs_id, "appStoreVersion", "appStoreVersions", ver["id"])
    if gv and gv["attributes"].get("state") in DRAFT_STATES:
        ok = add_item(rs_id, "subscriptionGroupVersion", "subscriptionGroupVersions", gv["id"]) and ok
    elif not gv:
        ok = add_item(rs_id, "subscriptionGroup", "subscriptionGroups", g["id"]) and ok
    for pid, s, sv in sub_versions:
        if sv and sv["attributes"].get("state") in DRAFT_STATES:
            ok = add_item(rs_id, "subscriptionVersion", "subscriptionVersions", sv["id"]) and ok
        else:
            ok = add_item(rs_id, "subscription", "subscriptions", s["id"]) and ok
    items = must("GET", f"/v1/reviewSubmissions/{rs_id}/items?limit=50")["data"]
    for it in items:
        print("ITEM", it["id"], it["attributes"].get("state"),
              {k: (v.get("data") or {}).get("id") for k, v in (it.get("relationships") or {}).items() if isinstance(v, dict) and v.get("data")})
    if not ok:
        raise SystemExit(f"could not add every item to reviewSubmission {rs_id}; NOT submitted")

    j = must("PATCH", f"/v1/reviewSubmissions/{rs_id}", {"data": {"type": "reviewSubmissions", "id": rs_id,
                                                                    "attributes": {"submitted": True}}})
    a = j["data"]["attributes"]
    print("SUBMIT_OK submission_id=", rs_id, "state=", a.get("state"), "submittedDate=", a.get("submittedDate"))
    time.sleep(10)
    status(app_id)


if __name__ == "__main__":
    main()
