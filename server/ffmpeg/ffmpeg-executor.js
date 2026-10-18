// Safe FFmpeg execution: no shell, bounded time/output, args pre-validated by the commander.
import { execFile } from 'child_process';

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 10 * 1024 * 1024;
const MAX_TAIL = 4000;

/**
 * FFmpeg binary the inference engine invokes. FFMPEG_PATH wins when set (the same
 * binary /api/health probes); otherwise the first `ffmpeg` on PATH.
 */
export const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

/** Low-level runner: resolves { stdout, stderr, code } and never rejects on non-zero exit. */
export function runProcess(bin, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        timedOut: Boolean(error && error.killed),
        spawnError: error && typeof error.code === 'string' ? error.code : null,
      });
    });
  });
}

/**
 * Execute a validated command ({ args }) and return a standard result:
 * { ok, output, stderr, error? }
 */
export async function executeCommand(command, { run = runProcess, bin = FFMPEG_BIN, timeoutMs } = {}) {
  if (!command || !Array.isArray(command.args) || !command.args.length) {
    return { ok: false, error: 'No command to execute', stderr: '' };
  }
  const res = await run(bin, command.args, { timeoutMs });
  const stderr = res.stderr.slice(-MAX_TAIL);
  if (res.code === 0) return { ok: true, output: command.outputPath, stderr };
  let error = `ffmpeg exited with code ${res.code}`;
  if (res.timedOut) error = 'ffmpeg timed out';
  else if (res.spawnError) error = `ffmpeg could not be started (${res.spawnError})`;
  return { ok: false, error, stderr };
}
