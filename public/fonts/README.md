# Caption fonts (lazy-loaded)

`NotoSansSC-Regular.ttf` (10.1 MB) and `NotoSansJP-Regular.ttf` (5.5 MB) are static
Regular instances (instantiated from the variable fonts in google/fonts with
`fonttools varLib.instancer`, wght=400, family renamed to "Noto Sans SC" / "Noto Sans JP").

The in-browser editor (`src/wasm/ffmpegEngine.js`) fetches one of them from `/fonts/`
only when burned captions or text need CJK glyphs the bundled Inter cannot draw;
otherwise nothing is downloaded. Same-origin, cached by the browser after the first use.

SIL Open Font License 1.1 — see OFL.txt. Upstream: https://github.com/google/fonts
(ofl/notosanssc, ofl/notosansjp).
