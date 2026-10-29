#!/usr/bin/env python3
"""Fetch App Store Connect SALES/SUMMARY reports (daily + monthly) as TSV files,
plus a totals.json the ingest step verifies the database mirror against.

Env: APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID, APP_STORE_CONNECT_API_KEY_P8
Args: --mode sync|backfill --out DIR

sync:    DAILY for the last 12 days, MONTHLY for the previous 2 complete months.
backfill: MONTHLY from 2024-01, DAILY from 2026-01-01.
A 404 for a single date means Apple has no report for it yet (or no sales);
it is tolerated unless nothing at all could be fetched.
"""
import argparse, gzip, json, os, sys, time, urllib.request, urllib.error
from datetime import date, timedelta
import jwt  # PyJWT

VENDOR = "85942810"
APPS = {"6815060815": "finalcap", "6813991381": "protune"}
BASE = "https://api.appstoreconnect.apple.com/v1/salesReports"


def make_jwt():
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["APP_STORE_CONNECT_ISSUER_ID"], "iat": now, "exp": now + 900,
         "aud": "appstoreconnect-v1"},
        os.environ["APP_STORE_CONNECT_API_KEY_P8"],
        algorithm="ES256",
        headers={"kid": os.environ["APP_STORE_CONNECT_KEY_ID"], "typ": "JWT"})


def fetch(token, freq, report_date):
    q = (f"?filter[frequency]={freq}&filter[reportType]=SALES&filter[reportSubType]=SUMMARY"
         f"&filter[vendorNumber]={VENDOR}&filter[reportDate]={report_date}")
    req = urllib.request.Request(BASE + q, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/a-gzip"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return gzip.decompress(resp.read()).decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code in (404, 410):
            return None  # no report for that date, or aged out of Apple's retention
        body = e.read()[:300].decode(errors="replace")
        raise SystemExit(f"salesReports {freq} {report_date}: HTTP {e.code} {body}")


def totals_for(tsv):
    lines = tsv.splitlines()
    if not lines:
        return {}
    hdr = lines[0].split("\t")
    idx = {name: i for i, name in enumerate(hdr)}
    def col(row, name):
        i = idx.get(name)
        return row[i] if i is not None and i < len(row) else ""
    out = {}
    for line in lines[1:]:
        if not line.strip():
            continue
        row = line.split("\t")
        app = col(row, "Apple Identifier")
        if app not in APPS:
            continue
        units = int(float(col(row, "Units") or 0))
        proceeds = float(col(row, "Developer Proceeds") or 0)
        ccy = col(row, "Currency of Proceeds")
        begin = col(row, "Begin Date")
        ent = out.setdefault(app, {"rows": 0, "units": 0, "proceeds": {}, "period_start": begin})
        ent["rows"] += 1
        ent["units"] += units
        ent["proceeds"][ccy] = round(ent["proceeds"].get(ccy, 0.0) + units * proceeds, 2)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["sync", "backfill"], default="sync")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    token = make_jwt()
    today = date.today()
    jobs = []  # (freq, report_date str)
    if a.mode == "sync":
        for d in range(1, 13):
            day = today - timedelta(days=d)
            jobs.append(("DAILY", day.isoformat()))
        first = today.replace(day=1)
        for _ in range(2):
            first = (first - timedelta(days=1)).replace(day=1)
            jobs.append(("MONTHLY", first.isoformat()))
    else:
        m = date(2024, 1, 1)
        last_month = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
        while m <= last_month:
            jobs.append(("MONTHLY", m.isoformat()))
            m = (m + timedelta(days=32)).replace(day=1)
        day = date(2026, 1, 1)
        while day < today:
            jobs.append(("DAILY", day.isoformat()))
            day += timedelta(days=1)
        # Weekly reports are retained 52 weeks (per Apple's 410 detail), so they
        # reach back a year where daily/monthly have already aged out. The
        # reportDate must be the Sunday ending the desired week.
        sunday = today - timedelta(days=(today.weekday() + 1) % 7)
        for _ in range(52):
            jobs.append(("WEEKLY", sunday.isoformat()))
            sunday -= timedelta(days=7)
    totals = {}
    fetched = 0
    for freq, rdate in jobs:
        # The API wants YYYY-MM for MONTHLY, YYYY-MM-DD for DAILY.
        qdate = rdate[:7] if freq == "MONTHLY" else rdate
        tsv = fetch(token, freq, qdate)
        if tsv is None:
            continue
        name = f"{freq}_{rdate}"
        with open(os.path.join(a.out, name + ".tsv"), "w") as f:
            f.write(tsv)
        totals[name] = {"granularity": freq, "apps": totals_for(tsv)}
        fetched += 1
    with open(os.path.join(a.out, "totals.json"), "w") as f:
        json.dump(totals, f, indent=1)
    print(f"mode={a.mode} fetched={fetched} of {len(jobs)} reports")
    for name, t in sorted(totals.items()):
        for app, ent in t["apps"].items():
            print(f"  {name} {APPS[app]}: rows={ent['rows']} units={ent['units']} proceeds={ent['proceeds']}")
    if fetched == 0:
        raise SystemExit("no reports fetched at all")


if __name__ == "__main__":
    main()
