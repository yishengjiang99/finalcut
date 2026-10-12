// Leak + style lint for blog posts. Any finding fails the build (scripts/build-blog.mjs), so an
// internal detail cannot reach https://grepawk.com/blog. Test: src/test/blog.test.js.
const LEAKS = [
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b(?!\.)/, 'IPv4 address'],
  [/\bssh\s+\S+@|\b[a-z_][\w-]*@\d|\broot@/i, 'ssh target / user@host'],
  [/\bsecrets\.[A-Z_]|\$\{\{\s*secrets/i, 'GitHub secret reference'],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{10,}|\bxai-[A-Za-z0-9]{10,}|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}|\bsk_live_|\bwhsec_/, 'token-like string'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----|\.p8\b|\.p12\b|\.mobileprovision\b/i, 'key or signing material'],
  [/\b[A-Z0-9_]*(?:API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)[A-Z0-9_]*\b/, 'secret variable name'],
  [/(?:^|[\s("'`])\/api\/[\w/-]+/m, 'API endpoint path'],
  [/\bApp Store Connect\b|\bASC\b|\bTestFlight\b|\bbundle id\b|\bcom\.ragnus\.|\bSKU\b|\b(?:app|ASC) id\b|\bid ?6[0-9]{9}\b(?![^\s]*apps\.apple\.com)/i, 'App Store Connect detail'],
  [/\/home\/|\/etc\/nginx|\/var\/www|\bsystemd\b|\bnginx -t\b/i, 'server path or ops detail'],
  [/\bDEPLOY_[A-Z_]+|\bgrepawk-deploy\b/, 'deploy variable'],
];
const STYLE = [
  [/\u2014/, 'em dash (use a comma, colon or a new sentence)'],
  [/\bfinal ?cut\b/i, 'say FinalCap, not "Final Cut"'],
  [/\b(?:delve|tapestry|seamless(?:ly)?|leverag(?:e|es|ing)|game[- ]changer|unlock the|in today's|robust|cutting-edge|revolutioniz\w*|elevate|embark|realm|harness(?:es|ing)?)\b/i, 'AI vocabulary'],
];

/** Returns a list of `rule: excerpt` findings for one post (front matter + body). */
export function lintPost(text, { allowUrls = [] } = {}) {
  let t = text;
  // App Store URLs are allowed even though they carry the numeric app id.
  t = t.replace(/https:\/\/apps\.apple\.com\/[^\s)"'>]+/g, 'APPSTOREURL');
  for (const u of allowUrls) t = t.split(u).join('ALLOWEDURL');
  const out = [];
  for (const [re, rule] of [...LEAKS, ...STYLE]) {
    const m = re.exec(t);
    if (m) out.push(`${rule}: "${t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).replace(/\s+/g, ' ').trim()}"`);
  }
  // Sentence case headings: after the first word, no capitalised common words (proper nouns pass
  // when they appear in the allowlist the caller can extend through the `properNouns` front matter).
  return out;
}

const SMALL = new Set(['a', 'an', 'and', 'or', 'the', 'of', 'to', 'in', 'on', 'for', 'with', 'vs', 'by', 'at', 'from', 'is', 'it', 'how', 'what', 'why', 'we', 'our', 'into', 'not', 'one', 'two', 'three', 'every', 'each', 'plain']);
/** Heading lines that look Title Cased ("How We Built It"): 3+ capitalised words that are not proper nouns. */
export function titleCaseHeadings(md, properNouns = []) {
  const proper = new Set(properNouns);
  const bad = [];
  for (const line of md.split('\n')) {
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (!h) continue;
    const words = h[1].split(/\s+/).slice(1).filter((w) => /^[A-Z][a-z]+$/.test(w) && !proper.has(w));
    const lower = words.filter((w) => SMALL.has(w.toLowerCase()));
    if (words.length >= 3 || lower.length >= 1) bad.push(`sentence case heading: "${h[1]}"`);
  }
  return bad;
}
