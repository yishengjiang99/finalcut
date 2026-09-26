// Shared client detection (User-Agent + auth method) for FinalCap iOS vs web.
//
// iOS app builds >= 10 send `User-Agent: FinalCap-iOS/<build>`. Every iOS build (including
// build 9 and earlier, which send the default URLSession UA "FinalCap/<build> CFNetwork/…")
// authenticates with an opaque mobile Bearer token (`Authorization: Bearer …`, minted by
// POST /api/auth/mobile/device or /api/auth/mobile/google; PR #46). The web app never sends
// a Bearer token: it uses the Google OAuth cookie session (req.authMethod === "session") or
// the sample-access-token header.

const IOS_UA_PREFIX = 'FinalCap-iOS';
const IOS_UA_BUILD_RE = /^FinalCap-iOS\/(\d+)/;

/**
 * Parse a User-Agent. `isFinalCapIos` is true for any UA starting with "FinalCap-iOS";
 * `build` is the integer build from `FinalCap-iOS/<build>`, or null when missing/unparseable.
 * @returns {{ isFinalCapIos: boolean, build: number|null }}
 */
export function parseFinalCapIosUserAgent(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent.trim() : '';
  if (!ua.startsWith(IOS_UA_PREFIX)) return { isFinalCapIos: false, build: null };
  const m = IOS_UA_BUILD_RE.exec(ua);
  const build = m ? Number(m[1]) : NaN;
  return { isFinalCapIos: true, build: Number.isSafeInteger(build) ? build : null };
}

function headerOf(req, name) {
  if (typeof req?.get === 'function') return req.get(name);
  return req?.headers?.[name.toLowerCase()];
}

/**
 * Is this request from the FinalCap iOS app?
 * - authenticated with a mobile Bearer token (all iOS builds, including build 9), or
 * - a `FinalCap-iOS/*` User-Agent on a request that is NOT a web cookie session.
 * A web cookie-session request is never an iOS client, whatever its User-Agent says.
 * Call after requireAuthenticatedUser / attachBearerUser (they set req.authMethod).
 */
export function isIosClient(req) {
  if (req?.authMethod === 'session') return false;
  if (req?.authMethod === 'bearer') return true;
  return parseFinalCapIosUserAgent(headerOf(req, 'user-agent')).isFinalCapIos;
}

/**
 * FREE_EDITS_IOS=unlimited turns the free daily limit off for iOS clients.
 * Unset or any other value keeps the normal limit. Read from the process environment
 * (.env / service env), so changing it takes a restart, not a code change.
 */
export function isFreeEditsIosUnlimited(env = process.env) {
  return String(env.FREE_EDITS_IOS ?? '').trim().toLowerCase() === 'unlimited';
}

/** True when the free limit is off for this request (iOS client + FREE_EDITS_IOS=unlimited). */
export function hasUnlimitedFreeEdits(req, env = process.env) {
  return isFreeEditsIosUnlimited(env) && isIosClient(req);
}
