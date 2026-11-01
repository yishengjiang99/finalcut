// add_soundtrack off switch (SOUNDTRACK_ENABLED=0, on by default) and limits, shared by the
// tool schema and the GBK route (server/tools/gbk-soundtrack-tool.js). No middleware imports.
export const soundtrackEnabled = (env = process.env) => !/^(0|false|off)$/i.test(String(env.SOUNDTRACK_ENABLED ?? '').trim());
export const SOUNDTRACK_MIN_SECONDS = 5;
export const SOUNDTRACK_MAX_SECONDS = 300; // GBK server-render cap for accounts
export const SOUNDTRACK_STYLES = ['pop', 'ambient', 'jazz', 'classical', 'baroque'];

/** Without the off switch, a tool list minus add_soundtrack (same array when on). */
export const withSoundtrackSwitch = (list, env = process.env) =>
  soundtrackEnabled(env) ? list : list.filter(t => t?.function?.name !== 'add_soundtrack');
