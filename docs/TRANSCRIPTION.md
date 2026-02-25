# Developer Guide: Video Text Transcription

## Overview

FinalCut implements a multi-layered transcription system that converts spoken audio in video files into subtitle text. It supports two distinct transcription pipelines:

1. **Standard Caption Generation** — via the xAI Grok Realtime WebSocket API
2. **Speaker Diarization** — via the OpenAI Batch Audio Transcription HTTP API

Both pipelines produce SRT and VTT subtitle files and optionally burn the subtitles permanently into the video. An optional third step translates the generated captions using the Grok-3 chat API.

---

## How It Works

### User Interaction

Users request transcription through the chat interface using natural language:

```
"Generate captions for my video"
"Transcribe this video in Spanish"
"Add subtitles and translate them to French"
"Transcribe with speaker labels"
```

### AI Processing

The xAI Grok API interprets the request and calls the `generate_captions` tool with appropriate parameters:

```javascript
{
  "language": "auto",
  "translate_language": "fr",
  "style": "white_on_black",
  "position": "bottom",
  "burn_in": true
}
```

### Processing Steps

```
User prompt → xAI Grok API → toolFunctions.generate_captions()
  → POST /api/generate-captions → xAI Realtime WebSocket → SRT/VTT
  → [optional] POST /api/translate-captions → Grok-3 chat → translated SRT/VTT
  → [optional] POST /api/process-video (burn_subtitles) → FFmpeg → video with subtitles
  → UI updates with video + downloadable subtitle files
```

---

## Components

### 1. Tool Definition (`src/tools.js`)

The `generate_captions` tool is registered in the Grok tool schema and describes the parameters the AI model can use:

```javascript
{
  type: 'function',
  function: {
    name: 'generate_captions',
    description: 'Automatically generate subtitles/captions from the video audio using speech-to-text AI (xAI Grok)...',
    parameters: {
      language: {
        type: 'string',
        description: 'Language for transcription (e.g., "en", "es", "fr", "de", "ja", "zh"). Use "auto" for automatic detection.',
        default: 'auto'
      },
      translate_language: {
        type: 'string',
        description: 'Optional target language code to translate the captions into using Grok chat.'
      },
      style: {
        type: 'string',
        enum: ['default', 'white_on_black', 'yellow'],
        default: 'default'
      },
      position: {
        type: 'string',
        enum: ['bottom', 'top'],
        default: 'bottom'
      },
      burn_in: {
        type: 'boolean',
        description: 'Whether to burn subtitles permanently into the video frames.',
        default: true
      }
    }
  }
}
```

---

### 2. Client Function (`src/toolFunctions.js`)

**Function: `generate_captions(args, videoFileData, setVideoFileData, addMessage)`**

Executes the 4-step caption generation workflow:

**Step 1 — Generate captions** via `POST /api/generate-captions`:
```javascript
const captionResponse = await fetch('/api/generate-captions', {
  method: 'POST',
  headers: {
    'Content-Type': fileMimeType,       // e.g. 'video/mp4'
    'x-args': JSON.stringify({ language })
  },
  body: videoFileData
});
const { srt, vtt } = await captionResponse.json();
```

**Step 2 — Show transcript excerpt and offer subtitle downloads**:
- Creates `Blob` objects for SRT and VTT content
- Calls `addMessage()` with download URLs for both formats
- Displays a short preview of the transcript text in chat

**Step 3 — Optionally translate** via `POST /api/translate-captions`:
```javascript
const translateResponse = await fetch('/api/translate-captions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ srtContent: srt, targetLanguage: translateLanguage })
});
const { srt: translatedSrt, vtt: translatedVtt } = await translateResponse.json();
```

**Step 4 — Optionally burn subtitles** via `POST /api/process-video`:
```javascript
const formData = new FormData();
formData.append('video', videoBlob, 'input.mp4');
formData.append('operation', 'burn_subtitles');
formData.append('args', JSON.stringify({
  srtContent: srt,
  translatedSrtContent: translatedSrt,  // null if no translation
  style,
  position
}));
const burnResponse = await fetch('/api/process-video', {
  method: 'POST',
  body: formData
});
const data = new Uint8Array(await burnResponse.arrayBuffer());
setVideoFileData(data);   // Updates React state with new video binary
```

---

### 3. Standard Caption Endpoint (`server.js`)

#### `POST /api/generate-captions`

**Middleware:** `videoProcessLimiter` (20 req/15 min) → `requireAuthenticatedUser` → `requireActiveSubscription`

**Flow:**
1. Read the raw video binary from the request body
2. Write it to a temporary file in `/tmp`
3. Extract audio to a mono MP3 at 16 kHz, 64 kbps using FFmpeg
4. Read the MP3 into a Base64 string
5. Call `transcribeAudioViaVoiceAgent(audioBase64, languageInstruction)`
6. Convert the returned SRT to VTT format using `srtToVtt()`
7. Return `{ srt, vtt }` as JSON

**Audio Extraction (FFmpeg):**
```javascript
ffmpeg(tmpInputPath)
  .noVideo()
  .audioChannels(1)          // Mono
  .audioFrequency(16000)     // 16 kHz
  .audioBitrate('64k')       // 64 kbps
  .toFormat('mp3')
```

---

### 4. xAI Realtime WebSocket Transcription (`server.js`)

**Function: `transcribeAudioViaVoiceAgent(audioBase64, languageInstruction)`**

Connects to the xAI Realtime API over WebSocket to perform speech-to-text transcription.

**WebSocket URL:** `wss://api.x.ai/v1/realtime`

**Protocol flow:**
1. Open WebSocket connection with `Authorization: Bearer <XAI_API_TOKEN>`
2. Send `session.update` to configure the session:
   ```javascript
   {
     type: 'session.update',
     session: {
       modalities: ['text', 'audio'],
       instructions: 'Please transcribe this audio and [languageInstruction]. Output ONLY valid SRT subtitle format with accurate timestamps...',
       voice: null,
       turn_detection: null,
       input_audio_transcription: { model: 'whisper-1' }
     }
   }
   ```
3. Append the audio as a Base64-encoded chunk:
   ```javascript
   { type: 'input_audio_buffer.append', audio: audioBase64 }
   ```
4. Commit the audio buffer:
   ```javascript
   { type: 'input_audio_buffer.commit' }
   ```
5. Trigger response creation:
   ```javascript
   { type: 'response.create' }
   ```
6. Collect `response.text.delta` events, concatenate into the final SRT string
7. Resolve on `response.done` or reject on `error` / timeout

**Timeout:** 120 seconds

**Output:** Raw SRT-formatted string with sequence numbers, timestamps, and subtitle text

---

### 5. Speaker Diarization Endpoint (`server.js`)

#### `POST /api/generate-captions-diarized`

**Middleware:** `videoProcessLimiter` → `requireAuthenticatedUser` → `requireActiveSubscription`

**Prerequisite:** Requires the `OPENAI_API_KEY` environment variable. Returns `503` if not configured.

**Flow:**
1. Write the video body to a temp file
2. Extract audio to WAV using `extractAudioToWav()`
3. Check WAV file size; if > 25 MB, split into chunks with `splitAudioIfNeeded()`
4. Transcribe each chunk using `transcribeWithOpenAI(chunkPath, startSec)`
5. Merge all chunk results using `mergeDiarizedSegmentsWithOffsets()`
6. Build SRT and VTT using `buildSrtAndVtt()`
7. Return `{ srt, vtt, hasDiarization }` as JSON

#### Helper: `extractAudioToWav(inputPath, outputPath)` (lines 745–757)

```javascript
ffmpeg(inputPath)
  .audioFrequency(16000)     // 16 kHz — required by Whisper-based models
  .audioChannels(1)           // Mono
  .audioCodec('pcm_s16le')    // PCM 16-bit signed little-endian
  .noVideo()
  .toFormat('wav')
```

#### Helper: `splitAudioIfNeeded(wavPath)` (lines 769–803)

Splits large WAV files into time-based chunks safe for the OpenAI 25 MB file limit.

- **Size threshold:** 25 MB (`26,214,400` bytes)
- **Chunk duration:** 720 seconds (12 minutes) → ~23 MB at 16 kHz mono PCM
- **Output:** Array of `{ path, startSec }` objects for sequential transcription

```javascript
// Each chunk is extracted with:
ffmpeg(wavPath)
  .setStartTime(offsetSec)
  .duration(CHUNK_DURATION_SEC)
  .audioCodec('copy')
  .toFormat('wav')
```

#### Helper: `transcribeWithOpenAI(filePath, timestampOffsetSec)` (lines 818–892)

Sends a WAV file to the OpenAI Audio Transcriptions endpoint, with an automatic model fallback chain:

| Priority | Model | Response Format | Speaker Labels |
|----------|-------|-----------------|----------------|
| 1 | `gpt-4o-transcribe-diarize` | `diarized_json` | ✅ Yes |
| 2 | `gpt-4o-transcribe` | `verbose_json` | ❌ No |
| 3 | `gpt-4o-mini-transcribe` | `verbose_json` | ❌ No |
| 4 | `whisper-1` | `verbose_json` | ❌ No |

**Request:**
```javascript
const form = new FormData();
form.append('file', audioBuffer, 'audio.wav');
form.append('model', model);
form.append('response_format', format);          // 'diarized_json' or 'verbose_json'
if (format === 'verbose_json') {
  form.append('timestamp_granularities[]', 'segment');
}
// POST https://api.openai.com/v1/audio/transcriptions
```

**Response normalization:**
- `diarized_json` segments: `{ start, end, speaker: "1" | "2" | …, text }`
  → transformed to `{ start, end, speaker: "Speaker 1", text }`
- `verbose_json` segments: `{ start, end, text }` (speaker is `null`)
- `timestampOffsetSec` is added to all `start`/`end` values for multi-chunk merging

#### Helper: `mergeDiarizedSegmentsWithOffsets(chunksResults)` (lines 895–902)

Flattens the per-chunk segment arrays into a single list, filters out empty segments, and sorts by `start` time.

#### Helper: `secondsToTimestamp(sec, vtt)` (lines 909–916)

Converts a floating-point number of seconds into a subtitle timestamp string:

- **SRT format:** `HH:MM:SS,mmm` (comma before milliseconds)
- **VTT format:** `HH:MM:SS.mmm` (dot before milliseconds)

#### Helper: `buildSrtAndVtt(segments)` (lines 925–947)

Generates both SRT and VTT subtitle strings from an array of `{ start, end, speaker, text }` segments:

```javascript
// Each SRT entry:
`${index}\n${srtStart} --> ${srtEnd}\n${speaker ? speaker + ': ' : ''}${text}\n`

// VTT starts with the required 'WEBVTT\n\n' header
```

Speaker labels are prefixed as `"Speaker 1: "`, `"Speaker 2: "`, etc. when present.

---

### 6. Caption Translation (`server.js`)

#### `POST /api/translate-captions`

**Middleware:** `apiLimiter` → `requireAuthenticatedUser` → `requireActiveSubscription`

**Request body:** `{ srtContent: string, targetLanguage: string }`

**Flow:**
1. Pass the full SRT content to the Grok-3 chat model
2. System prompt instructs the model to:
   - Preserve all sequence numbers and timestamp lines exactly as-is
   - Only translate the dialogue text lines
   - Return a complete SRT document with no commentary
3. Convert the resulting SRT to VTT via `srtToVtt()`
4. Return `{ srt, vtt }`

---

### 7. Subtitle Burning (`server.js`)

#### `POST /api/process-video` with `operation: 'burn_subtitles'`

**Request:** `multipart/form-data` with fields:
- `video`: The source video file
- `operation`: `"burn_subtitles"`
- `args`: JSON string with `{ srtContent, translatedSrtContent, style, position }`

**Subtitle Styles:**

| Style | Description | Font Color | Background |
|-------|-------------|------------|------------|
| `default` | White text with black outline | White | None |
| `white_on_black` | White text on semi-transparent black box | White | 50% black |
| `yellow` | Yellow text with black outline | Yellow | None |

**Dual-Track Burning:**

When `translatedSrtContent` is provided, both subtitle tracks are burned simultaneously:
- Original language: at the specified `position` (`bottom` or `top`), font size 20
- Translated language: at the opposite position, font size 18

**FFmpeg ASS/SSA filter configuration:**
```javascript
// Example: bottom position, white_on_black style
const assStyle = [
  'FontSize=20',
  'Alignment=2',              // 2 = bottom-center (numpad layout)
  'PrimaryColour=&H00FFFFFF', // White
  'OutlineColour=&H00000000', // Black
  'BackColour=&H80000000',    // 50% transparent black
  'BorderStyle=4',            // Opaque box
  'Outline=0',
  'Shadow=0'
].join(',');

// FFmpeg vf filter string:
`subtitles='${srtPath1}':force_style='${style1}',subtitles='${srtPath2}':force_style='${style2}'`
```

The FFmpeg command is executed via `fluent-ffmpeg` and streams the output MP4 directly back to the HTTP response.

---

## Data Flow Diagrams

### Standard Caption Generation

```
User: "Add captions"
    ↓
Grok API → generate_captions({ language: 'auto', burn_in: true })
    ↓
toolFunctions.generate_captions()
    ↓
POST /api/generate-captions
    ├── FFmpeg: video → mono MP3 (16 kHz, 64 kbps)
    ├── MP3 → base64
    ├── xAI WSS API (whisper-1 transcription model)
    │       session.update → audio.append → audio.commit → response.create
    │       ← response.text.delta (SRT chunks) … response.done
    └── srtToVtt() → { srt, vtt }
    ↓
[optional] POST /api/translate-captions
    ├── Grok-3 chat: translate SRT text only
    └── { srt, vtt } (translated)
    ↓
[if burn_in=true] POST /api/process-video (burn_subtitles)
    ├── FFmpeg: subtitles() filter (ASS/SSA style)
    └── → video binary (MP4)
    ↓
UI: setVideoFileData(data) + downloadable SRT/VTT links
```

### Speaker Diarization

```
User: "Transcribe with speaker labels"
    ↓
POST /api/generate-captions-diarized
    ├── FFmpeg: video → WAV (16 kHz, mono, PCM 16-bit LE)
    ├── [if WAV > 25 MB] splitAudioIfNeeded()
    │       FFmpeg: WAV → N × 12-min chunks with startSec offsets
    ├── For each chunk:
    │   transcribeWithOpenAI(chunkPath, startSec)
    │       Try: gpt-4o-transcribe-diarize (diarized_json)
    │       Fallback: gpt-4o-transcribe (verbose_json)
    │       Fallback: gpt-4o-mini-transcribe (verbose_json)
    │       Fallback: whisper-1 (verbose_json)
    │       → normalize segments, apply timestamp offset
    ├── mergeDiarizedSegmentsWithOffsets() → flat sorted segments[]
    ├── buildSrtAndVtt() → { srt, vtt }
    │       secondsToTimestamp() for each segment
    │       prefix "Speaker N: " when diarization available
    └── { srt, vtt, hasDiarization }
    ↓
UI: downloadable SRT/VTT files (+ optional burn-in)
```

---

## API Reference

### `POST /api/generate-captions`

| Property | Value |
|----------|-------|
| Rate limit | 20 requests per 15 minutes |
| Auth | Required (active subscription) |
| Content-Type | `video/mp4` (or actual MIME type) |
| Header | `x-args: { "language": "<code or auto>" }` |
| Response | `{ srt: string, vtt: string }` |

### `POST /api/generate-captions-diarized`

| Property | Value |
|----------|-------|
| Rate limit | 20 requests per 15 minutes |
| Auth | Required (active subscription) |
| Prerequisite | `OPENAI_API_KEY` env variable |
| Content-Type | `video/mp4` (or actual MIME type) |
| Response | `{ srt: string, vtt: string, hasDiarization: boolean }` |
| Error (no key) | `503 { error: 'OPENAI_API_KEY is not configured...' }` |

### `POST /api/translate-captions`

| Property | Value |
|----------|-------|
| Rate limit | API rate limiter |
| Auth | Required (active subscription) |
| Content-Type | `application/json` |
| Body | `{ srtContent: string, targetLanguage: string }` |
| Response | `{ srt: string, vtt: string }` |

### `POST /api/process-video` (`burn_subtitles` operation)

| Property | Value |
|----------|-------|
| Content-Type | `multipart/form-data` |
| Fields | `video` (file), `operation: "burn_subtitles"`, `args` (JSON) |
| Args fields | `srtContent`, `translatedSrtContent?`, `style`, `position` |
| Response | `video/mp4` binary stream |

---

## Environment Configuration

```bash
# Required for standard caption generation
XAI_API_TOKEN=<your xAI API token>

# Optional — required only for speaker diarization
OPENAI_API_KEY=<your OpenAI API key>

# Required for session management
SESSION_SECRET=<random secret>

# Optional — enable public demo/sample mode
ALLOW_UNAUTH_SAMPLE_MODE=true
SAMPLE_TOKEN_TTL_MS=600000   # 10 minutes
```

---

## Testing

Unit tests covering the diarization helpers are in `src/test/diarization.test.js`.

### Test Coverage

**SRT/VTT generation (`buildSrtAndVtt` + `secondsToTimestamp`):**
- Empty segment arrays produce empty output
- Speaker labels are prefixed correctly (`"Speaker 1: "`)
- Timestamps are formatted as `HH:MM:SS,mmm` (SRT) and `HH:MM:SS.mmm` (VTT)
- Hours, minutes, and sub-second precision are handled correctly
- Sequence numbers increment starting from `1`
- Segments without speaker labels omit the speaker prefix
- VTT output starts with the `WEBVTT` header

**Batch API configuration:**
- Endpoint: `POST /api/generate-captions-diarized`
- Primary model: `gpt-4o-transcribe-diarize` with `diarized_json` format
- Fallback chain: `gpt-4o-transcribe` → `gpt-4o-mini-transcribe` → `whisper-1`
- Audio config: 16 kHz, 1 channel (mono), PCM 16-bit LE, WAV format
- Max file size threshold: 25 MB (26,214,400 bytes)

### Run Tests

```bash
npm test -- src/test/diarization.test.js
```

---

## Key Design Decisions

| Feature | Technology | Rationale |
|---------|-----------|-----------|
| Standard captions | xAI Grok Realtime WSS | Low-latency streaming, integrated with chat API |
| Speaker diarization | OpenAI Batch HTTP API | Only API offering per-segment speaker IDs (`diarized_json`) |
| Translation | Grok-3 chat API | Preserves SRT structure; handles multi-language professional formatting |
| Subtitle burning | FFmpeg ASS/SSA filter | Rich styling, dual-track support, frame-accurate embedding |
| Audio extraction | FFmpeg (PCM WAV) | Consistent 16 kHz mono format required by all Whisper-based models |
| Chunk duration | 12 minutes / ~23 MB | Safely under the 25 MB OpenAI Audio API file size limit |
| xAI transcription model | `whisper-1` | Used inside the xAI Realtime session for accurate SRT timestamps |

---

## Common Issues

**1. No captions generated (empty SRT)**
- Check that the video contains an audio track
- Verify `XAI_API_TOKEN` is set and valid
- Check server logs for WebSocket errors or timeout (120 s limit)

**2. Diarization endpoint returns 503**
- `OPENAI_API_KEY` is not set in the environment
- Set the key and restart the server

**3. Speaker labels not appearing**
- The primary model (`gpt-4o-transcribe-diarize`) may have returned an error; the system fell back to a non-diarizing model
- Check server logs for `[diarize] Falling back from gpt-4o-transcribe-diarize` messages

**4. Large videos fail or time out**
- Audio WAV extraction must complete before transcription starts
- Files over 25 MB are split automatically; verify FFmpeg is installed and accessible
- The xAI WebSocket has a 120-second timeout; very long videos may need the diarization endpoint instead

**5. Subtitles not visible after burn-in**
- Verify `srtContent` is valid SRT (sequence number, timestamp line, text, blank line)
- Check FFmpeg logs for `subtitles` filter errors
- Ensure the temporary SRT file path has no special characters
