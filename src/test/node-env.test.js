// @vitest-environment node
// NODE_ENV comes from systemd (runtime) and the build script (Vite), never from .env files.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { nodeEnvWarning } from '../server/config.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(path.join(repo, f), 'utf8');

describe('NODE_ENV handling', () => {
  it('warns at startup only when NODE_ENV is missing (outside tests)', () => {
    expect(nodeEnvWarning({})).toMatch(/NODE_ENV is not set.*Environment=NODE_ENV=production/);
    expect(nodeEnvWarning({ NODE_ENV: 'production' })).toBeNull();
    expect(nodeEnvWarning({ NODE_ENV: 'development' })).toBeNull();
    expect(nodeEnvWarning({ VITEST: 'true' })).toBeNull();
  });

  it('the build sets NODE_ENV=production itself', () => {
    expect(JSON.parse(read('package.json')).scripts.build).toMatch(/(^|&& )NODE_ENV=production vite build$/);
  });

  it('env templates do not set NODE_ENV; the systemd unit does', () => {
    expect(read('.env.example')).not.toMatch(/^\s*NODE_ENV\s*=/m);
    const unit = read('finalcut.service');
    expect(unit).toMatch(/^Environment=NODE_ENV=production$/m);
    expect(unit).toMatch(/^EnvironmentFile=\/home\/finalcut\/apps\/pages\/finalcut\/\.env$/m);
    expect(unit).toMatch(/^User=finalcut$/m);
  });

  it('only .env.example is tracked; every other .env file stays out of git', () => {
    const tracked = execFileSync('git', ['ls-files', '--', '.env*'], { cwd: repo, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    expect(tracked).toEqual(['.env.example']);
    const ignore = read('.gitignore');
    expect(ignore).toMatch(/^\.env\*$/m);
    expect(ignore).toMatch(/^!\.env\.example$/m);
  });
});
