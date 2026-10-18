// FinalCap push lifecycle — segment rules (pure, no I/O). See docs/push-lifecycle.md.
//
// Inputs are counts and times only: install date, server-side edit counts per day
// (daily_inference_usage, already kept for the free quota), subscription flag, and the few
// allowlisted push-lifecycle events the app reports after notifications are allowed
// (app_open, export_done, paywall_view). Never prompts, media, frames or captions.

const H = 3600_000;
const D = 24 * H;

export const SEGMENTS = Object.freeze({
  edit_not_exported: { id: 'edit_not_exported', cls: 'feature', priority: 10, destination: 'editor',
    goal: 'They edited a clip recently but did not export it. Remind them that Export saves the finished video straight to Photos, so it is worth exporting edits they like.' },
  onboarding_d1: { id: 'onboarding_d1', cls: 'feature', priority: 20, destination: 'editor',
    goal: 'Day 1 tip: open a clip and type or say an edit in plain words, for example "trim the first 3 seconds" or "make it black and white".' },
  onboarding_d3: { id: 'onboarding_d3', cls: 'feature', priority: 21, destination: 'editor',
    goal: 'Day 3 tip: ask for captions and FinalCap writes them on the iPhone.' },
  onboarding_d7: { id: 'onboarding_d7', cls: 'feature', priority: 22, destination: 'editor',
    goal: 'Day 7 tip: captions can be translated into another language by asking in the chat.' },
  paywall_not_converted: { id: 'paywall_not_converted', cls: 'promotional', priority: 30, destination: 'paywall',
    goal: 'They looked at FinalCap Pro but did not subscribe. Calmly say what Pro includes: unlimited AI edits, captions and translations. No pressure.' },
  new_feature: { id: 'new_feature', cls: 'promotional', priority: 40, destination: 'editor',
    goal: 'Tell them about a feature that is now in the app.' },
  inactive_7: { id: 'inactive_7', cls: 'promotional', priority: 50, destination: 'editor',
    goal: 'About a week away. Suggest one quick, concrete edit they could try on a recent clip.' },
  inactive_14: { id: 'inactive_14', cls: 'promotional', priority: 51, destination: 'editor',
    goal: 'Two weeks away. Suggest captions for a recent video as an easy win.' },
  winback_30: { id: 'winback_30', cls: 'promotional', priority: 52, destination: 'editor',
    goal: 'A month away; one final gentle check-in with one concrete thing to try. After this we stay quiet.' },
});

/** Announcements are inactive until the feature is in the live App Store build. */
export const FEATURE_ANNOUNCEMENTS = [
  { id: 'lyric_captions_v1', active: false, fact: 'Lyric captions: FinalCap can find a song\'s lyrics and caption your music video (needs Cloud processing on).', destination: 'editor' },
];

const toMs = (d) => (d instanceof Date ? d.getTime() : d ? Date.parse(d) : NaN);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {{createdAt: Date|string|null, edits: Array<{day:string,count:number,lastAt:Date|string|null}>,
 *          events: Array<{event:string, at:Date|string}>, lastSessionAt?: Date|string|null,
 *          hasSubscription: boolean}} a
 */
export function featuresFrom(a, now = new Date()) {
  const t = now.getTime();
  const install = toMs(a.createdAt);
  let lastEdit = NaN;
  let edits7d = 0;
  let editsTotal = 0;
  for (const e of a.edits || []) {
    const at = toMs(e.lastAt) || Date.parse(`${e.day}T12:00:00Z`);
    const n = Number(e.count) || 0;
    if (n <= 0) continue;
    editsTotal += n;
    if (t - at <= 7 * D) edits7d += n;
    if (!(lastEdit >= at)) lastEdit = at;
  }
  let lastExport = NaN; let exportsTotal = 0; let lastPaywall = NaN; let lastOpen = NaN; let reportsEvents = false;
  for (const e of a.events || []) {
    const at = toMs(e.at);
    if (!Number.isFinite(at) || at > t + 5 * 60_000) continue;
    reportsEvents = true;
    if (e.event === 'export_done') { exportsTotal++; if (!(lastExport >= at)) lastExport = at; }
    if (e.event === 'paywall_view' && !(lastPaywall >= at)) lastPaywall = at;
    if (e.event === 'app_open' && !(lastOpen >= at)) lastOpen = at;
  }
  const lastSession = toMs(a.lastSessionAt);
  const lastSeen = Math.max(...[lastEdit, lastOpen, lastExport, lastSession, install].filter(Number.isFinite));
  return {
    daysSinceInstall: Number.isFinite(install) ? (t - install) / D : null,
    hoursInactive: Number.isFinite(lastSeen) ? (t - lastSeen) / H : null,
    lastSeenAt: Number.isFinite(lastSeen) ? lastSeen : null,
    edits7d, editsTotal,
    lastEditAt: Number.isFinite(lastEdit) ? lastEdit : null,
    exportsTotal,
    lastExportAt: Number.isFinite(lastExport) ? lastExport : null,
    lastPaywallViewAt: Number.isFinite(lastPaywall) ? lastPaywall : null,
    reportsEvents,
    tier: a.hasSubscription ? 'pro' : 'free',
  };
}

/** All matching segments, highest priority first. */
export function matchSegments(f, now = new Date(), { usedAnnouncements = new Set(), paywallEnabled = true } = {}) {
  const t = now.getTime();
  const out = [];
  const idleH = f.hoursInactive ?? 0;
  const dsi = f.daysSinceInstall;

  // Edited 2–48 h ago, nothing exported since — only for installs that report export events.
  if (f.reportsEvents && f.lastEditAt && idleH >= 2) {
    const age = t - f.lastEditAt;
    const exportedAfter = f.lastExportAt && f.lastExportAt >= f.lastEditAt;
    if (age >= 2 * H && age <= 48 * H && !exportedAfter) out.push({ segment: SEGMENTS.edit_not_exported, dedupeKey: `edit_not_exported:${day(f.lastEditAt)}` });
  }
  if (dsi !== null) {
    if (dsi >= 1 && dsi < 2 && idleH >= 12) out.push({ segment: SEGMENTS.onboarding_d1, dedupeKey: 'onboarding_d1' });
    if (dsi >= 3 && dsi < 4 && idleH >= 24) out.push({ segment: SEGMENTS.onboarding_d3, dedupeKey: 'onboarding_d3' });
    if (dsi >= 7 && dsi < 8 && idleH >= 48) out.push({ segment: SEGMENTS.onboarding_d7, dedupeKey: 'onboarding_d7' });
  }
  // FinalCap Pro has no free trial, so there is no trial-ending message at all.
  if (paywallEnabled && f.tier === 'free' && f.lastPaywallViewAt && idleH >= 12) {
    const age = t - f.lastPaywallViewAt;
    if (age >= 20 * H && age <= 72 * H) out.push({ segment: SEGMENTS.paywall_not_converted, dedupeKey: `paywall_not_converted:${Math.floor(f.lastPaywallViewAt / (30 * D))}` });
  }
  if (dsi !== null && dsi >= 3 && idleH >= 24 && idleH <= 30 * 24) {
    const ann = FEATURE_ANNOUNCEMENTS.find((a) => a.active && !usedAnnouncements.has(a.id));
    if (ann) out.push({ segment: { ...SEGMENTS.new_feature, destination: ann.destination }, dedupeKey: `new_feature:${ann.id}`, announcement: ann });
  }
  const di = idleH / 24;
  if (f.lastSeenAt && dsi !== null && dsi >= 8) {
    const ep = day(f.lastSeenAt);
    if (di >= 7 && di < 14) out.push({ segment: SEGMENTS.inactive_7, dedupeKey: `inactive_7:${ep}` });
    else if (di >= 14 && di < 30) out.push({ segment: SEGMENTS.inactive_14, dedupeKey: `inactive_14:${ep}` });
    else if (di >= 30 && di < 45) out.push({ segment: SEGMENTS.winback_30, dedupeKey: `winback_30:${ep}` });
  }
  return out.sort((a, b) => a.segment.priority - b.segment.priority);
}

/** Coarse facts for the copy writer: no ids, no timestamps. */
export function copyFactsFor(f, m) {
  const e = f.edits7d;
  return {
    tier: f.tier,
    editsLastWeek: e === 0 ? '0' : e <= 3 ? '1-3' : '4+',
    hasExported: f.exportsTotal > 0,
    ...(m.announcement ? { announcement: m.announcement.fact } : {}),
  };
}
