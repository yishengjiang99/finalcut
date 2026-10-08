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
    expect(addFfmpegFallbackTool(body, 'FinalCap-iOS/10')).toBe(body);
    expect(buildSystemMessage({ ffmpegFallback: true }).content).toContain('ffmpeg_cli');
    expect(buildSystemMessage().content).not.toContain('ffmpeg_cli');
  });
});
