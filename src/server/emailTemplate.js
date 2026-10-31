// Shared layout for every email sent through Resend: a simple branded HTML body with inline CSS
// (readable in light and dark mail clients), a matching plain-text body, and a footer that names
// the company and says why the recipient got the message. Marketing-type emails pass
// `unsubscribeUrl`, which adds a footer link (headers are added by the sender, see composeLifecycle).
export const BRAND = 'FinalCut';
export const PRODUCT = 'GBK Composer';
export const LOGO_URL = 'https://grepawk.com/apple-touch-icon.png';
export const SITE_URL = 'https://grepawk.com';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// blocks: [{ p: 'text' } | { button: { label, url } } | { small: 'text' }]
export function renderEmail({ preheader = '', heading, blocks, reason, unsubscribeUrl = null }) {
  const footerText = [
    `${BRAND} (${PRODUCT}) · ${SITE_URL.replace('https://', '')}`,
    reason,
    ...(unsubscribeUrl ? [`Unsubscribe from these emails: ${unsubscribeUrl}`] : []),
  ];
  const text = [
    heading, '',
    ...blocks.flatMap((b) => (b.button ? [`${b.button.label}: ${b.button.url}`, ''] : [b.p ?? b.small, ''])),
    '--', ...footerText,
  ].join('\n');

  const body = blocks.map((b) => {
    if (b.button) {
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;"><tr><td style="border-radius:6px;background-color:#4f46e5;">`
        + `<a href="${esc(b.button.url)}" style="display:inline-block;padding:12px 22px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${esc(b.button.label)}</a>`
        + `</td></tr></table>`
        + `<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:#6b7280;">Or paste this link into your browser:<br><a href="${esc(b.button.url)}" style="color:#4f46e5;word-break:break-all;">${esc(b.button.url)}</a></p>`;
    }
    if (b.small) return `<p style="margin:0 0 16px;font-size:14px;line-height:22px;color:#6b7280;">${esc(b.small)}</p>`;
    return `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#1f2937;">${esc(b.p)}</p>`;
  }).join('\n');

  const unsub = unsubscribeUrl
    ? `<br><a href="${esc(unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline;">Unsubscribe from these emails</a>`
    : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:10px;">
<tr><td style="padding:24px 32px 8px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><img src="${LOGO_URL}" width="32" height="32" alt="${BRAND}" style="display:block;border:0;border-radius:6px;"></td>
<td style="vertical-align:middle;padding-left:10px;font-size:18px;font-weight:700;color:#111827;">${BRAND}</td>
</tr></table></td></tr>
<tr><td style="padding:16px 32px 8px;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:700;color:#111827;">${esc(heading)}</h1>
${body}
</td></tr>
<tr><td style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;font-size:12px;line-height:18px;color:#6b7280;">
${BRAND} (${PRODUCT}) · <a href="${SITE_URL}" style="color:#6b7280;">grepawk.com</a><br>${esc(reason)}${unsub}
</td></tr>
</table></td></tr></table>
</body></html>`;
  return { text, html };
}
