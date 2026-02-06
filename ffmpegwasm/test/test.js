// tests/test.js

function ok(cond, msg) {
    if (!cond) throw new Error(msg);
}

function logSection(title) {
    console.log(`\n=== ${title} ===`);
}

async function loadFFmpeg() {
    const { default: FFmpegWasm } = await import("/ffmpeg.js");

    return await FFmpegWasm({
        locateFile: p => `/${p}`,
        print: (...args) => console.log("[ffmpeg]", ...args),
        printErr: (...args) => console.error("[ffmpeg]", ...args),
    });
}

async function testVersion(ffmpeg) {
    logSection("CLI boots");

    await ffmpeg.callMain(["-version"]);

    console.log("✅ ffmpeg -version executed");
}

async function testTranscode(ffmpeg) {
    logSection("WAV -> PCM16");

    // Generate a tiny WAV (440hz sine) using raw PCM
    const sampleRate = 44100;
    const duration = 1;
    const samples = sampleRate * duration;

    const buffer = new Int16Array(samples);

    for (let i = 0; i < samples; i++) {
        buffer[i] = Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 32767;
    }

    // Write raw PCM
    ffmpeg.FS("writeFile", "tone.pcm", new Uint8Array(buffer.buffer));

    // Wrap into WAV via ffmpeg itself
    await ffmpeg.callMain([
        "-f", "s16le",
        "-ar", "44100",
        "-ac", "1",
        "-i", "tone.pcm",
        "tone.wav"
    ]);

    ok(ffmpeg.FS("readdir", "/").includes("tone.wav"), "tone.wav missing");

    // Decode again -> pcm
    await ffmpeg.callMain([
        "-i", "tone.wav",
        "-f", "s16le",
        "out.pcm"
    ]);

    const out = ffmpeg.FS("readFile", "out.pcm");

    ok(out.length > 0, "output pcm empty");

    console.log("✅ transcoding succeeded");
}

async function testBadInput(ffmpeg) {
    logSection("Bad input returns error");

    let failed = false;

    try {
        await ffmpeg.callMain([
            "-i", "does_not_exist.wav",
            "out.wav"
        ]);
    } catch {
        failed = true;
    }

    ok(failed, "ffmpeg should throw on invalid input");

    console.log("✅ invalid input detected");
}

async function runAll() {
    try {
        const ffmpeg = await loadFFmpeg();

        await testVersion(ffmpeg);
        await testTranscode(ffmpeg);
        await testBadInput(ffmpeg);

        console.log("\n🎉 All tests passed");
    } catch (err) {
        console.error("\n❌ Test failure:", err);
    }
}

runAll();