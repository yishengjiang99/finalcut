````markdown
# ffmpeg-wasm (CLI)

FFmpeg compiled to WebAssembly with the native CLI enabled.  
Built with Docker for reproducibility and optimized for controlled codec support and smaller binaries.

---

## Features

- Native `ffmpeg` CLI available in WASM
- Docker-based deterministic builds
- Dev and release build modes
- No npm dependencies
- Explicit codec configuration

---

## Requirements

- Docker (BuildKit recommended; enabled by default in Docker Desktop)
- Python 3 (for local static server)
- GNU Make (optional but recommended)

---

## Build

### Fast Development Build

Build without link-time optimization for faster iteration:

```bash
make dev
````

### Production Build

Smaller binary using LTO and closure:

```bash
make release
```

Artifacts are written to:

```
dist/
  ffmpeg.js
  ffmpeg.wasm
```

---

## Run Locally

Serve the `dist` directory:

```bash
cd dist
python3 -m http.server 8000
```

Open:

```
http://localhost:8000
```

---

## Usage

Load the module:

```js
const { default: FFmpegWasm } = await import("/ffmpeg.js");

const ffmpeg = await FFmpegWasm({
  locateFile: p => `/${p}`
});
```

Run CLI commands:

```js
await ffmpeg.callMain([
  "-i", "input.wav",
  "output.mp3"
]);
```

---

## Makefile Targets

| Target         | Description             |
| -------------- | ----------------------- |
| `make dev`     | Fast build (no LTO)     |
| `make release` | Smaller optimized build |
| `make serve`   | Serve `dist/` locally   |
| `make clean`   | Remove build artifacts  |

Configurable variables:

```
BUILD_MODE=dev|release
FFMPEG_REF=n6.1.1
PORT=8000
DIST_DIR=dist
```

Example:

```bash
make release FFMPEG_REF=n7.0
```

---

## Notes

* `--disable-everything` is used; codecs must be explicitly enabled.
* Changing configure flags invalidates Docker cache and triggers a full rebuild.
* Release builds take longer but produce smaller binaries.
* WASM builds are larger than native binaries due to static linking.

---

## License

FFmpeg is licensed under LGPL or GPL depending on configuration.
You are responsible for verifying license compliance before distributing binaries.

[https://ffmpeg.org/legal.html](https://ffmpeg.org/legal.html)

```
```
