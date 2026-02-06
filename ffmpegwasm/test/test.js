/* eslint-disable no-console */

/**
 * Zero-npm tiny test runner + ffmpeg.js integration tests.
 * Assumes ffmpeg.js + ffmpeg.wasm are served at:
 *   ../ffmpeg.js
 *   ../ffmpeg.wasm
 */

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

function log(line) {
    logEl.textContent += line + "\n";
}

function ok(cond, msg = "assertion failed") {
    if (!cond) throw new Error(msg);
}

function eq(a, b, msg = "expected equality") {
    if (a !== b) throw new Error(`${msg}: ${a} !== ${b}`);
}

function bytesToAscii(u8, start, len) {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(u8[start + i]);
    return s;
}

/**
 * Generate a simple PCM16 WAV (mono).
 */
function makeSineWav({
    durationSec = 0.25,
    sampleRate = 44100,
    freqHz = 440,
    amplitude = 0.25,
} = {}) {
    const numSamples = Math.floor(durationSec * sampleRate);
    const numChannels = 1;
    const bitsPerSample = 16;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numSamples * blockAlign;

    // WAV header is 44 bytes
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    let o = 0;

    // RIFF
    view.setUint32(o, 0x52494646, false); o += 4; // "RIFF"
    view.setUint32(o, 36 + dataSize, true); o += 4;
    view.setUint32(o, 0x57415645, false); o += 4; // "WAVE"

    // fmt  chunk
    view.setUint32(o, 0x666d7420, false); o += 4; // "fmt "
    view.setUint32(o, 16, true); o += 4; // PCM chunk size
    view.setUint16(o, 1, true); o += 2; // audio format = PCM
    view.setUint16(o, numChannels, true); o += 2;
    view.setUint32(o, sampleRate, true); o += 4;
    view.setUint32(o, byteRate, true); o += 4;
    view.setUint16(o, blockAlign, true); o += 2;
    view.setUint16(o, bitsPerSample, true); o += 2;

    // data chunk
    view.setUint32(o, 0x64617461, false); o += 4; // "data"
    view.setUint32(o, dataSize, true); o += 4;

    // PCM samples
    const out = new Int16Array(buffer, 44, numSamples);
    for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const sample = Math.sin(2 * Math.PI * freqHz * t) * amplitude;
        out[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
    }

    return new Uint8Array(buffer);
}

/**
 * Convert ["-i","in.wav", ...] to newline-separated args string for run_ffmpeg().
 * The wrapper expects tokens separated by '\n'.
 *
 * Include argv[0] (program name) as the first token.
 */
function toArgsNL(argsArray) {
    return ["ffmpeg", ...argsArray].join("\n");
}

async function loadFFmpegModule() {
    // ffmpeg.js is an ES module default-exporting the factory (MODULARIZE=1, EXPORT_ES6=1).
    const createModule = (await import("../dist/ffmpeg.js")).default;

    // locateFile controls where ffmpeg.wasm is loaded from.
    const mod = await createModule({
        locateFile: (p) => (p.endsWith(".wasm") ? "../" + p : p),
    });

    // Create a working directory to keep tests clean.
    try { mod.FS.mkdir("/work"); } catch { }
    mod.FS.chdir("/work");

    return mod;
}

async function runAll() {
    statusEl.textContent = "Initializing ffmpeg module…";
    const mod = await loadFFmpegModule();

    // Grab exported function
    const run_ffmpeg = mod.cwrap("run_ffmpeg", "number", ["string"]);

    const tests = [];

    function test(name, fn) {
        tests.push({ name, fn });
    }

    // --- Tests ---

    test("Module loads and FS works", async () => {
        mod.FS.writeFile("hello.txt", new Uint8Array([1, 2, 3]));
        const got = mod.FS.readFile("hello.txt");
        eq(got.length, 3, "FS read/write");
    });

    test("WAV -> PCM16LE via libav* wrapper", async () => {
        const wav = makeSineWav({ durationSec: 0.2, freqHz: 440 });
        mod.FS.writeFile("in.wav", wav);

        const wav_to_pcm16le_fs = mod.cwrap("wav_to_pcm16le_fs", "number", ["string", "string"]);

        const rc = wav_to_pcm16le_fs("in.wav", "out.pcm");
        eq(rc, 0, "decode should succeed");

        const pcm = mod.FS.readFile("out.pcm");
        ok(pcm.length > 1000, "pcm output should be non-trivial");

        // Very light sanity check: PCM isn't a RIFF/WAV header
        const head = pcm.slice(0, 4);
        const s = String.fromCharCode(...head);
        ok(s !== "RIFF", "raw pcm should not start with RIFF");
    });

    test("Missing input returns non-zero", async () => {
        const wav_to_pcm16le_fs = mod.cwrap("wav_to_pcm16le_fs", "number", ["string", "string"]);
        const rc = wav_to_pcm16le_fs("does_not_exist.wav", "out.pcm");
        ok(rc !== 0, "expected non-zero return code");
    });

    // --- Run ---
    statusEl.textContent = "Running tests…";
    let passed = 0;

    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            log(`✅ ${t.name}`);
        } catch (e) {
            log(`❌ ${t.name}`);
            log(`   ${e && e.stack ? e.stack : String(e)}`);
        }
    }

    const summary = `${passed}/${tests.length} passed`;
    statusEl.innerHTML = passed === tests.length
        ? `<span class="pass">${summary}</span>`
        : `<span class="fail">${summary}</span>`;
}

runAll().catch((e) => {
    statusEl.innerHTML = `<span class="fail">Fatal: ${String(e)}</span>`;
    log(e && e.stack ? e.stack : String(e));
});