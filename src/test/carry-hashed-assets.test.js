// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'fs';
import os from 'os';
import path from 'path';

const script = new URL('../../scripts/carry-hashed-assets.sh', import.meta.url).pathname;

function put(file, body, ageDays = 0) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  const t = Date.now() / 1000 - ageDays * 86400;
  utimesSync(file, t, t);
}

describe('scripts/carry-hashed-assets.sh', () => {
  it('keeps the previous build bundle reachable after a deploy, without overwriting or reviving old ones', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'carry-'));
    const oldDist = path.join(root, 'dist');
    const newDist = path.join(root, 'dist.new');
    put(path.join(oldDist, 'index.html'), '<script src="/assets/index-OLD.js">');
    put(path.join(oldDist, 'assets/index-OLD.js'), 'old bundle');
    put(path.join(oldDist, 'assets/shared.css'), 'old css');
    put(path.join(oldDist, 'assets/index-ANCIENT.js'), 'ancient', 30);
    put(path.join(oldDist, 'v2/assets/v2-OLD.js'), 'old v2');
    put(path.join(newDist, 'index.html'), '<script src="/assets/index-NEW.js">');
    put(path.join(newDist, 'assets/index-NEW.js'), 'new bundle');
    put(path.join(newDist, 'assets/shared.css'), 'new css');
    mkdirSync(path.join(newDist, 'v2/assets'), { recursive: true });

    const r = spawnSync('bash', [script, oldDist, newDist], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(path.join(newDist, 'assets/index-OLD.js'), 'utf8')).toBe('old bundle');
    expect(readFileSync(path.join(newDist, 'v2/assets/v2-OLD.js'), 'utf8')).toBe('old v2');
    expect(readFileSync(path.join(newDist, 'assets/shared.css'), 'utf8')).toBe('new css');
    expect(readFileSync(path.join(newDist, 'index.html'), 'utf8')).toContain('index-NEW.js');
    expect(existsSync(path.join(newDist, 'assets/index-ANCIENT.js'))).toBe(false);
    expect(r.stdout).toContain('carried 2 ');
  });
});
