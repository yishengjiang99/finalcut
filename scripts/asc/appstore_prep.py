"""Copy missing 1.2 App Store version fields from the live version (no submission)."""
import json, os, time, urllib.request, urllib.error
import jwt
E = os.environ
tok = jwt.encode({'iss': E['APP_STORE_CONNECT_ISSUER_ID'].strip(), 'iat': int(time.time()), 'exp': int(time.time()) + 1200,
                  'aud': 'appstoreconnect-v1'}, E['APP_STORE_CONNECT_API_KEY_P8'].replace('\\n', '\n').strip(),
                 algorithm='ES256', headers={'kid': E['APP_STORE_CONNECT_KEY_ID'].strip()})
def api(m, p, b=None):
    r = urllib.request.Request('https://api.appstoreconnect.apple.com' + p, method=m,
        data=None if b is None else json.dumps(b).encode(), headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=90) as x: return json.loads(x.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        print('WARN', m, p, e.code, e.read().decode()[:1200]); return None
app_id = api('GET', '/v1/apps?filter[bundleId]=com.ragnus.w2')['data'][0]['id']
vs = api('GET', f'/v1/apps/{app_id}/appStoreVersions?filter[platform]=IOS&limit=10')['data']
new = next(v for v in vs if v['attributes']['versionString'] == '1.2')
live = next(v for v in vs if v['attributes']['appStoreState'] == 'READY_FOR_SALE')
print('live', live['attributes']['versionString'], {k: live['attributes'].get(k) for k in ('releaseType', 'copyright')})
print('new', {k: new['attributes'].get(k) for k in ('appStoreState', 'releaseType', 'copyright')})
upd = {k: live['attributes'][k] for k in ('releaseType', 'copyright') if not new['attributes'].get(k) and live['attributes'].get(k)}
if not new['attributes'].get('releaseType') and 'releaseType' not in upd: upd['releaseType'] = 'AFTER_APPROVAL'
if upd: print('patch version', upd, bool(api('PATCH', f"/v1/appStoreVersions/{new['id']}", {'data': {'type': 'appStoreVersions', 'id': new['id'], 'attributes': upd}})))
L = lambda v: {l['attributes']['locale']: l for l in api('GET', f"/v1/appStoreVersions/{v['id']}/appStoreVersionLocalizations")['data']}
ll, nl = L(live), L(new)
for loc, l in ll.items():
    fields = ('description', 'keywords', 'promotionalText', 'marketingUrl', 'supportUrl')
    if loc not in nl:
        a = {k: l['attributes'][k] for k in fields if l['attributes'].get(k)}; a['locale'] = loc
        print('create loc', loc, bool(api('POST', '/v1/appStoreVersionLocalizations', {'data': {'type': 'appStoreVersionLocalizations', 'attributes': a,
            'relationships': {'appStoreVersion': {'data': {'type': 'appStoreVersions', 'id': new['id']}}}}})))
        continue
    a = {k: l['attributes'][k] for k in fields if l['attributes'].get(k) and not nl[loc]['attributes'].get(k)}
    if a: print('patch loc', loc, list(a), bool(api('PATCH', f"/v1/appStoreVersionLocalizations/{nl[loc]['id']}", {'data': {'type': 'appStoreVersionLocalizations', 'id': nl[loc]['id'], 'attributes': a}})))
for loc, l in L(new).items(): print('final loc', loc, {k: bool(v) for k, v in l['attributes'].items() if k != 'locale'})
rd = (api('GET', f"/v1/appStoreVersions/{new['id']}/appStoreReviewDetail") or {}).get('data')
if not rd:
    old = (api('GET', f"/v1/appStoreVersions/{live['id']}/appStoreReviewDetail") or {}).get('data')
    if old:
        a = {k: v for k, v in old['attributes'].items() if v is not None and k not in ('demoAccountPassword',)}
        if old['attributes'].get('demoAccountPassword'): a['demoAccountPassword'] = old['attributes']['demoAccountPassword']
        print('create review detail', bool(api('POST', '/v1/appStoreReviewDetails', {'data': {'type': 'appStoreReviewDetails', 'attributes': a,
            'relationships': {'appStoreVersion': {'data': {'type': 'appStoreVersions', 'id': new['id']}}}}})))
else: print('review detail exists')
