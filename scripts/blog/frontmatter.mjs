// Minimal front matter: `key: value` lines between --- fences. Values: true/false, [a, b] lists,
// optionally quoted strings. Enough for blog posts and photo-recipes article.html headers.
export function parseFrontMatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === 'true' || v === 'false') v = v === 'true';
    else if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    data[kv[1]] = v;
  }
  return { data, body: src.slice(m[0].length) };
}
