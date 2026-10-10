// Corresponding Source lock + fetch script: pinned checksums must be enforced.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fetch-ffmpeg-source.mjs');
const lock = JSON.parse(readFileSync(path.join(ROOT, 'vendor', 'ffmpeg-source.lock.json'), 'utf8'));

function runVerify(component, fileBytes) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ffsrc-'));
  writeFileSync(path.join(dir, component.file), fileBytes);
  const lockPath = path.join(dir, 'lock.json');
  writeFileSync(lockPath, JSON.stringify({ ...lock, components: [component] }));
  return spawnSync(process.execPath, [SCRIPT, '--verify'], {
    env: { ...process.env, FFMPEG_SOURCE_LOCK: lockPath, FFMPEG_SOURCE_CACHE: dir }, encoding: 'utf8',
  });
}

describe('vendor/ffmpeg-source.lock.json', () => {
  it('pins every library the ffmpeg.wasm 0.12.10 build links, with sha256 and exact refs', () => {
    expect(lock.packages).toEqual({ '@ffmpeg/core': '0.12.10', '@ffmpeg/core-mt': '0.12.10' });
    expect(lock.buildRecipe.commit).toBe('71aa99d37c02a7b4c435275ca9ef50e612f6efa1');
    const ids = lock.components.map((c) => c.id);
    for (const id of ['ffmpeg.wasm', 'ffmpeg', 'x264', 'x265', 'libvpx', 'lame', 'libogg', 'libtheora', 'opus', 'libvorbis',
      'zlib', 'libwebp', 'freetype', 'fribidi', 'harfbuzz', 'libass', 'zimg', 'sdl2', 'emscripten']) {
      expect(ids).toContain(id);
    }
    for (const c of lock.components) {
      expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(c.bytes).toBeGreaterThan(0);
      expect(c.url).toMatch(/^https:\/\//);
      if (c.commit) expect(c.commit).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(lock.components.find((c) => c.id === 'ffmpeg').version).toBe('5.1.4');
    expect(lock.components.find((c) => c.id === 'x264').commit).toBe('33cac6b77d5b9259c552156013a817ab23119612');
  });

  it('fails when an archive does not match its pinned checksum', () => {
    const fake = Buffer.from('not the real archive');
    const r = runVerify({ ...lock.components[0], file: 'x.tar.gz', bytes: fake.length }, fake);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/checksum mismatch|SHA-256 mismatch/);
  });

  it('passes when the archive matches', () => {
    const data = Buffer.from('fixture archive bytes');
    const c = { id: 't', name: 't', file: 't.bin', url: 'https://example.invalid/t.bin', bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex') };
    const r = runVerify(c, data);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
