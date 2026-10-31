// Writes HTML + text previews of every lifecycle email to docs/email-previews/ (sample data only).
import { writeFileSync, mkdirSync } from 'fs';
import { recoveryEmail, trialEndingEmail } from '../src/server/composeLifecycle.js';
const out = 'docs/email-previews';
mkdirSync(out, { recursive: true });
const samples = {
  recovery: recoveryEmail({ recoveryUrl: 'https://buy.stripe.com/r/EXAMPLE', unsubscribeUrl: 'https://grepawk.com/api/compose/unsubscribe?email=you%40example.com&sig=EXAMPLE' }),
  'trial-ending': trialEndingEmail({ trialEnd: 1793000000, planLabel: 'yearly ($47.99/year)', manageUrl: 'https://grepawk.com/api/compose/portal?email=you%40example.com&exp=0&sig=EXAMPLE' }),
};
for (const [name, m] of Object.entries(samples)) {
  writeFileSync(`${out}/${name}.html`, m.html);
  writeFileSync(`${out}/${name}.txt`, `Subject: ${m.subject}\n${m.headers ? Object.entries(m.headers).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n' : ''}\n${m.text}\n`);
}
