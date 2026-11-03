"""Set TestFlight What to Test on a build, add it to external groups, submit for beta review,
and set whatsNew on the App Store version (no App Store review submission)."""
import json, os, time, urllib.request, urllib.error
import jwt
E = os.environ
tok = jwt.encode({'iss': E['APP_STORE_CONNECT_ISSUER_ID'].strip(), 'iat': int(time.time()), 'exp': int(time.time()) + 1200,
                  'aud': 'appstoreconnect-v1'}, E['APP_STORE_CONNECT_API_KEY_P8'].replace('\\n', '\n').strip(),
                 algorithm='ES256', headers={'kid': E['APP_STORE_CONNECT_KEY_ID'].strip()})
def api(m, p, b=None, ok_fail=False):
    r = urllib.request.Request('https://api.appstoreconnect.apple.com' + p, method=m,
        data=None if b is None else json.dumps(b).encode(),
        headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=90) as x:
            return json.loads(x.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        msg = f'{m} {p} -> {e.code}: {e.read().decode()[:1500]}'
        if ok_fail: print('WARN', msg); return None
        raise SystemExit(msg)
notes = open(E['NOTES_FILE']).read().strip()
ver, bn = E['MARKETING_VERSION'], E['BUILD_NUMBER']
app_id = api('GET', f"/v1/apps?filter[bundleId]={E['BUNDLE_ID']}")['data'][0]['id']
bs = api('GET', f'/v1/builds?filter[app]={app_id}&filter[preReleaseVersion.version]={ver}&sort=-uploadedDate&limit=10')['data']
for b in bs: print('build', b['attributes']['version'], b['attributes']['processingState'], b['attributes'].get('usesNonExemptEncryption'), b['attributes'].get('expired'))
b = next(x for x in bs if x['attributes']['version'] == bn)
bid = b['id']
assert b['attributes']['processingState'] == 'VALID', 'build not processed'
if b['attributes'].get('usesNonExemptEncryption') is None:
    api('PATCH', f'/v1/builds/{bid}', {'data': {'type': 'builds', 'id': bid, 'attributes': {'usesNonExemptEncryption': False}}}); print('export compliance set')
# What to Test
locs = api('GET', f'/v1/builds/{bid}/betaBuildLocalizations')['data']
en = next((l for l in locs if l['attributes']['locale'] == 'en-US'), None)
if en: api('PATCH', f"/v1/betaBuildLocalizations/{en['id']}", {'data': {'type': 'betaBuildLocalizations', 'id': en['id'], 'attributes': {'whatsNew': notes}}})
else: api('POST', '/v1/betaBuildLocalizations', {'data': {'type': 'betaBuildLocalizations', 'attributes': {'locale': 'en-US', 'whatsNew': notes},
          'relationships': {'build': {'data': {'type': 'builds', 'id': bid}}}}})
print('whatToTest readback:', [l['attributes'] for l in api('GET', f'/v1/builds/{bid}/betaBuildLocalizations')['data']])
# external groups
groups = api('GET', f'/v1/apps/{app_id}/betaGroups?limit=50')['data']
for g in groups: print('group', g['attributes']['name'], 'internal', g['attributes'].get('isInternalGroup'), 'public', g['attributes'].get('publicLinkEnabled'))
ext = [g for g in groups if not g['attributes'].get('isInternalGroup')]
if ext:
    for g in ext: api('POST', f"/v1/betaGroups/{g['id']}/relationships/builds", {'data': [{'type': 'builds', 'id': bid}]}, ok_fail=True)
else: print('BLOCKER?: no external beta group')
print('beta review detail:', api('GET', f'/v1/apps/{app_id}/betaAppReviewDetail', ok_fail=True))
print('beta app localizations:', [l['attributes'] for l in (api('GET', f'/v1/apps/{app_id}/betaAppLocalizations', ok_fail=True) or {}).get('data', [])])
# submit
bd = api('GET', f'/v1/builds/{bid}/buildBetaDetail')['data']['attributes']; print('buildBetaDetail before', bd)
if bd.get('externalBuildState') in ('READY_FOR_BETA_SUBMISSION', 'MISSING_EXPORT_COMPLIANCE', None):
    print('submit:', api('POST', '/v1/betaAppReviewSubmissions', {'data': {'type': 'betaAppReviewSubmissions',
        'relationships': {'build': {'data': {'type': 'builds', 'id': bid}}}}}, ok_fail=True))
time.sleep(5)
print('buildBetaDetail after', api('GET', f'/v1/builds/{bid}/buildBetaDetail')['data']['attributes'])
print('review submission', api('GET', f'/v1/builds/{bid}/betaAppReviewSubmission', ok_fail=True))
# App Store version whatsNew (no review submission)
vs = api('GET', f'/v1/apps/{app_id}/appStoreVersions?filter[versionString]={ver}&filter[platform]=IOS')['data']
if not vs:
    v = api('POST', '/v1/appStoreVersions', {'data': {'type': 'appStoreVersions', 'attributes': {'platform': 'IOS', 'versionString': ver},
        'relationships': {'app': {'data': {'type': 'apps', 'id': app_id}}}}}, ok_fail=True)
    vs = [v['data']] if v else []; print('created version', ver, bool(vs))
if vs:
    vid = vs[0]['id']; print('version', ver, vs[0]['attributes'].get('appStoreState'))
    for l in api('GET', f'/v1/appStoreVersions/{vid}/appStoreVersionLocalizations')['data']:
        if l['attributes']['locale'] == 'en-US':
            api('PATCH', f"/v1/appStoreVersionLocalizations/{l['id']}", {'data': {'type': 'appStoreVersionLocalizations', 'id': l['id'], 'attributes': {'whatsNew': notes}}}, ok_fail=True)
            print('appstore whatsNew readback ok:', api('GET', f"/v1/appStoreVersionLocalizations/{l['id']}")['data']['attributes'].get('whatsNew') == notes)
