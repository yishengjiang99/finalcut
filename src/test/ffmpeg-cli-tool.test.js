import { describe, it, expect } from 'vitest';
import { FfmpegDiscovery, parseFilters } from '../../server/ffmpeg/ffmpeg-discovery.js';
import { buildCommand, validateFilterChain, CommandValidationError } from '../../server/ffmpeg/ffmpeg-commander.js';
import { executeCommand } from '../../server/ffmpeg/ffmpeg-executor.js';
import { routeToolRequest, withFfmpegFallback, planCommand } from '../../server/tools/ffmpeg-cli-tool.js';

const FILTERS = `Filters:
 T.. = Timeline support
 ... scale             V->V       Scale the input video size.
 T.. vignette          V->V       Make or reverse a vignette effect.
 TSC hue               V->V       Adjust the hue and saturation of the input video.
 ... aecho             A->A       Add echoing to the audio.
`;
const ENCODERS = `Encoders:
 V....D libx264              libx264 H.264 encoder
 A....D aac                  AAC (Advanced Audio Coding)
`;

function makeDiscovery() {
  const calls = [];
  const run = async (bin, args) => {
    calls.push(args.join(' '));
    const out = args.includes('-filters') ? FILTERS : args.includes('-encoders') ? ENCODERS : '';
    return { stdout: out, stderr: '', code: 0 };
  };
  return { d: new FfmpegDiscovery({ run, cachePath: null }), calls };
}

describe('ffmpeg discovery', () => {
  it('parses filters and caches CLI queries', async () => {
    const { d, calls } = makeDiscovery();
    expect(parseFilters(FILTERS).map(f => f.name)).toEqual(['scale', 'vignette', 'hue', 'aecho']);
    expect((await d.getFiltersMatching('vignette'))[0].name).toBe('vignette');
    await d.getFiltersMatching('echo');
    expect(calls.filter(c => c.includes('-filters')).length).toBe(1);
    expect(await d.hasEncoder('libx264')).toBe(true);
    expect(await d.suggestFilters('vignett')).toContain('vignette');
  });

  it('parses ffmpeg 8 two-char filter flags (and still accepts three-char)', () => {
    const v8 = 'Filters:\n TS aap               AA->A      Apply Affine Projection.\n .. abench            A->A       Benchmark part of a filtergraph.\n';
    expect(parseFilters(v8).map(f => f.name)).toEqual(['aap', 'abench']);
    expect(parseFilters(v8)[0].flags).toBe('TS');
    const v7 = 'Filters:\n TSC scale             V->V       Scale the input video size.\n';
    expect(parseFilters(v7).map(f => f.name)).toEqual(['scale']);
  });
});

describe('ffmpeg commander', () => {
  it('builds a command with an args array', async () => {
    const { d } = makeDiscovery();
    const cmd = await buildCommand({ inputPath: 'in.mp4', outputPath: 'out.mp4', intent: { videoFilters: 'vignette,hue=s=0', videoCodec: 'libx264' } }, d);
    expect(cmd.args).toEqual(['-hide_banner', '-y', '-nostdin', '-i', 'in.mp4', '-vf', 'vignette,hue=s=0', '-c:v', 'libx264', 'out.mp4']);
  });

  it('rejects unknown filters with suggestions', async () => {
    const { d } = makeDiscovery();
    const r = await validateFilterChain('vignett', d);
    expect(r.errors[0]).toMatch(/Unknown filter/);
    expect(r.suggestions.vignett).toContain('vignette');
  });

  it('rejects dangerous filters, file params and bad paths', async () => {
    const { d } = makeDiscovery();
    expect((await validateFilterChain('movie=/etc/passwd', d)).errors.length).toBe(1);
    expect((await validateFilterChain('scale=file:/etc/passwd', d)).errors.length).toBe(1);
    await expect(buildCommand({ inputPath: '-i', outputPath: 'o.mp4', intent: {} }, d)).rejects.toBeInstanceOf(CommandValidationError);
    await expect(buildCommand({ inputPath: 'http://x', outputPath: 'o.mp4', intent: {} }, d)).rejects.toBeInstanceOf(CommandValidationError);
  });
});

describe('ffmpeg executor', () => {
  it('returns standard results', async () => {
    const ok = await executeCommand({ args: ['-i', 'a'], outputPath: 'o' }, { run: async () => ({ stdout: '', stderr: 'x', code: 0 }) });
    expect(ok).toMatchObject({ ok: true, output: 'o' });
    const bad = await executeCommand({ args: ['-i', 'a'] }, { run: async () => ({ stdout: '', stderr: 'boom', code: 1 }) });
    expect(bad).toMatchObject({ ok: false, stderr: 'boom' });
  });
});

describe('routing', () => {
  it('prefers built-in tools and falls back otherwise', () => {
    expect(routeToolRequest('trim_video').route).toBe('builtin');
    expect(routeToolRequest('make_it_vintage').route).toBe('ffmpeg_cli');
    const names = withFfmpegFallback().map(t => t.function.name);
    expect(names[names.length - 1]).toBe('ffmpeg_cli');
  });

  it('plans with unsupported output format rejected', async () => {
    const r = await planCommand({ args: { output_format: 'exe' } });
    expect(r.ok).toBe(false);
  });
});

describe('chat integration', () => {
  it('adds ffmpeg_cli last for web, not for iOS, and only guides when enabled', async () => {
    const { addFfmpegFallbackTool, buildSystemMessage } = await import('../server/chat.js');
    const body = { tools: [{ type: 'function', function: { name: 'trim_video' } }] };
    const web = addFfmpegFallbackTool(body, 'Mozilla/5.0');
    expect(web.tools.map(t => t.function.name)).toEqual(['trim_video', 'ffmpeg_cli']);
    expect(addFfmpegFallbackTool(web, 'Mozilla/5.0')).toBe(web);
    // iOS: appended here too; the build allowlist (restrictStreamingBodyForIos) strips it
    // again for builds without the fallback executor.
    const ios = addFfmpegFallbackTool(body, 'FinalCap-iOS/10');
    expect(ios.tools.map(t => t.function.name)).toEqual(['trim_video', 'ffmpeg_cli']);
    expect(buildSystemMessage({ ffmpegFallback: true }).content).toContain('ffmpeg_cli');
    expect(buildSystemMessage({ ffmpegFallback: 'ios' }).content).toContain('on-device');
    expect(buildSystemMessage().content).not.toContain('ffmpeg_cli');
  });

  it('streaming: ffmpeg_cli survives for new iOS builds, stripped for old', async () => {
    const { addFfmpegFallbackTool, restrictStreamingBodyForIos } = await import('../server/chat.js');
    const body = { tools: [{ type: 'function', function: { name: 'trim_video' } }] };
    const composed11 = restrictStreamingBodyForIos(addFfmpegFallbackTool(body, 'FinalCap-iOS/11'), 'FinalCap-iOS/11');
    expect(composed11.tools.map(t => t.function.name)).toContain('ffmpeg_cli');
    const composed10 = restrictStreamingBodyForIos(addFfmpegFallbackTool(body, 'FinalCap-iOS/10'), 'FinalCap-iOS/10');
    expect(composed10.tools.map(t => t.function.name)).not.toContain('ffmpeg_cli');
  });
});

describe('ffmpeg binary selection', () => {
  it('defaults to FFMPEG_PATH (the binary /api/health probes), else PATH ffmpeg', async () => {
    const { FFMPEG_BIN } = await import('../../server/ffmpeg/ffmpeg-executor.js');
    expect(FFMPEG_BIN).toBe(process.env.FFMPEG_PATH || 'ffmpeg');
    const { FfmpegDiscovery } = await import('../../server/ffmpeg/ffmpeg-discovery.js');
    const d = new FfmpegDiscovery({ run: async () => ({ stdout: '', stderr: '', code: 0 }), cachePath: null });
    expect(d.bin).toBe(FFMPEG_BIN);
    const { executeCommand } = await import('../../server/ffmpeg/ffmpeg-executor.js');
    const seen = [];
    await executeCommand({ args: ['-version'], outputPath: 'o' }, { run: async (bin, args) => { seen.push(bin); return { stdout: '', stderr: '', code: 0 }; } });
    expect(seen).toEqual([FFMPEG_BIN]);
  });

  it('an explicit binary always wins over the default', async () => {
    const { executeCommand } = await import('../../server/ffmpeg/ffmpeg-executor.js');
    const seen = [];
    await executeCommand({ args: ['-version'], outputPath: 'o' }, {
      run: async (bin, args) => { seen.push({ bin, args }); return { stdout: '', stderr: '', code: 0 }; },
      bin: '/opt/ffmpeg/bin/ffmpeg',
    });
    expect(seen[0].bin).toBe('/opt/ffmpeg/bin/ffmpeg');
  });
});

describe('inference engine: runFfmpegCli invokes the configured ffmpeg CLI', () => {
  it('calls the configured binary with the validated args', async () => {
    const { FfmpegDiscovery } = await import('../../server/ffmpeg/ffmpeg-discovery.js');
    const { runFfmpegCli } = await import('../../server/tools/ffmpeg-cli-tool.js');
    const FILTERS = ' T.. vignette          V->V       Make or reverse a vignette effect.\n';
    const run = async (bin, args) => ({ stdout: args.includes('-filters') ? FILTERS : '', stderr: '', code: 0 });
    const discovery = new FfmpegDiscovery({ run, cachePath: null });
    const seen = [];
    const execRun = async (bin, args) => { seen.push({ bin, args }); return { stdout: '', stderr: '', code: 0 }; };
    const result = await runFfmpegCli(
      { args: { action: 'run', video_filters: 'vignette', output_format: 'mp4' }, inputPath: 'in.mp4' },
      { discovery, exec: { run: execRun, bin: 'custom-ffmpeg' } }
    );
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].bin).toBe('custom-ffmpeg');
    expect(seen[0].args).toContain('-vf');
    expect(seen[0].args).toContain('vignette');
    expect(seen[0].args).toContain('-nostdin');
    expect(result.command.startsWith('ffmpeg ')).toBe(true);
  });

  it('validation failures never reach the binary', async () => {
    const { FfmpegDiscovery } = await import('../../server/ffmpeg/ffmpeg-discovery.js');
    const { runFfmpegCli } = await import('../../server/tools/ffmpeg-cli-tool.js');
    const discovery = new FfmpegDiscovery({ run: async () => ({ stdout: '', stderr: '', code: 0 }), cachePath: null });
    const seen = [];
    const result = await runFfmpegCli(
      { args: { action: 'run', video_filters: 'nope_filter_xyz', output_format: 'mp4' }, inputPath: 'in.mp4' },
      { discovery, exec: { run: async (bin, args) => { seen.push(args); return { stdout: '', stderr: '', code: 0 }; }, bin: 'custom-ffmpeg' } }
    );
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
    expect(result.errors.join(';')).toMatch(/Unknown filter/);
  });
});

describe('iOS tool offering', () => {
  it('offers ffmpeg_cli last to qualifying builds, video only', async () => {
    const { offeredToolsFor, mediaTypesForTool } = await import('../server/toolsSchema.js');
    const names11 = offeredToolsFor({ userAgent: 'FinalCap-iOS/11' }).map(t => t.function.name);
    expect(names11[names11.length - 1]).toBe('ffmpeg_cli');
    const names10 = offeredToolsFor({ userAgent: 'FinalCap-iOS/10' }).map(t => t.function.name);
    expect(names10).not.toContain('ffmpeg_cli');
    expect(mediaTypesForTool('ffmpeg_cli')).toEqual(['video']);
    const names11img = offeredToolsFor({ userAgent: 'FinalCap-iOS/11', mediaType: 'image' }).map(t => t.function.name);
    expect(names11img).not.toContain('ffmpeg_cli');
    const web = offeredToolsFor({ userAgent: 'Mozilla/5.0' }).map(t => t.function.name);
    expect(web).not.toContain('ffmpeg_cli');
  });
});
