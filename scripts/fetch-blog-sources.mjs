#!/usr/bin/env node
// Fetch the opted-in blog folders of the sibling repos into .cache/blog-sources/<name>/ for
// scripts/build-blog.mjs. Sparse, shallow, anonymous HTTPS clones (the repos are public): only
// `blog/` (and `articles/` for photo-recipes link-out cards) is checked out, never docs/.
// BLOG_SOURCES_DIR=<dir> skips fetching and reads from that folder instead (tests, local runs).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES } from './blog/sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = path.join(ROOT, '.cache', 'blog-sources');
const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

export function fetchBlogSources() {
  mkdirSync(CACHE, { recursive: true });
  const manifest = {};
  for (const s of SOURCES) {
    if (s.local) continue;
    const dir = path.join(CACHE, s.name);
    rmSync(dir, { recursive: true, force: true });
    git(['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', `https://github.com/${s.repo}.git`, dir]);
    git(['sparse-checkout', 'set', '--no-cone', '/blog/', ...(s.articles ? ['/articles/'] : [])], dir);
    manifest[s.repo] = git(['rev-parse', 'HEAD'], dir);
    console.log(`blog sources: ${s.repo}@${manifest[s.repo].slice(0, 7)} (${existsSync(path.join(dir, 'blog')) ? 'blog/' : 'no blog/'})`);
  }
  writeFileSync(path.join(CACHE, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) fetchBlogSources();
