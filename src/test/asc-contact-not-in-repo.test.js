// @vitest-environment node
// The App Review contact (phone, email) lives in repo secrets ASC_REVIEW_CONTACT_PHONE / _EMAIL, not in code.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const FILES = ['scripts/asc/create_subscriptions.py', 'scripts/asc/submit_version_with_subscriptions.py', '.github/workflows/asc-finalcap-upload.yml'];
const PHONE = /\+?1?[ .-]?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/;
const EMAIL = /[A-Za-z0-9._%+-]+@(gmail|yahoo)\.com/i;

describe('ASC review contact comes from secrets', () => {
  for (const f of FILES) {
    it(`${f} has no hard-coded phone or personal email and reads the env vars`, () => {
      const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
      expect(src).not.toMatch(PHONE);
      expect(src).not.toMatch(EMAIL);
      expect(src).toContain('ASC_REVIEW_CONTACT_PHONE');
      expect(src).toContain('ASC_REVIEW_CONTACT_EMAIL');
    });
  }
});
