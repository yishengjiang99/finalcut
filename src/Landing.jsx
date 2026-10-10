import React, { useEffect, useRef } from 'react';
import logoUrl from './brand/logo-96.webp';
import posterUrl from './brand/explainer-poster.webp';
import explainerVideoUrl from '../docs/finalcap-explainer.mp4';

// Landing page for grepawk.com. It is pre-rendered into dist/index.html at build time
// (scripts/prerender-landing.mjs) so crawlers and first paint get real content before the JS
// bundle runs; React then replaces it with this same component. Keep every claim true for
// the main route: editing runs in the browser (ffmpeg.wasm), the video file is not uploaded to
// edit, and a step that needs the server asks first (see public/legal/privacy.html).

export const landingStats = [
  ['45', 'FFmpeg editing tools'],
  ['0', 'Uploads needed to edit'],
  ['9:16 · 1:1 · 16:9', 'Social formats'],
  ['MP4 · WebM · MOV', 'Export formats']
];

export const landingFeatures = [
  ['💬', 'Edit video by chat', 'Describe the edit in plain English. Trim, crop, resize, rotate or add text, and the AI builds the FFmpeg command for you.', 'trim seconds 5–15'],
  ['🔤', 'Auto captions and subtitles', 'Transcribe speech with a model that runs in your browser, translate the captions, and burn them in at the top or bottom.', 'add Spanish captions'],
  ['🎨', 'Color and transitions', 'Brightness, contrast, saturation, hue, color filters and transitions between clips, all real FFmpeg filters.', 'make it moodier'],
  ['📱', 'Resize for Reels, TikTok and Shorts', 'Reframe to 9:16 for Reels, TikTok and Shorts, 1:1 for feeds or 16:9 for YouTube with one sentence.', 'make it vertical'],
  ['⚡', 'Speed and audio', 'Change speed, volume and fades, normalize loudness, equalize, and trim silence from the start or end.', 'make it 2x faster'],
  ['📦', 'Convert and export', 'Convert to MP4, WebM, MOV or MKV, or extract the audio as MP3, WAV or AAC, rendered in your browser.', 'convert to WebM']
];

export const landingSteps = [
  ['Open your video', 'Pick a video or audio file, or try the built-in sample. The file stays on your device.', '“BigBuckBunny.mp4 attached ✓”'],
  ['Describe the edit', "Type it the way you'd brief an editor. Ask follow-ups, stack changes, and go back to any earlier version.", '“Cut the boring middle and punch up the colors”'],
  ['Download the result', "FFmpeg renders the edit in your browser. Save the file when it's ready.", '“✓ Done. Download MP4”']
];

export const landingExamples = [
  ['🏙️', 'linear-gradient(135deg,#1a2233,#2c3a58)', '“Convert to 9:16 for Instagram Reels”', '✓ Cropped to 1080×1920'],
  ['🎤', 'linear-gradient(135deg,#231a33,#3a2c58)', '“Generate captions and translate them to Spanish”', '✓ Captions transcribed, translated and burned in'],
  ['🌅', 'linear-gradient(135deg,#1a3327,#2c5844)', '“Trim 0:05–0:15, 2x speed, boost saturation”', '✓ 3 edits chained']
];

// Start the hero video only after the page has loaded, so its download does not compete with
// the first paint (the poster frame shows until then).
function useDeferredAutoplay(ref) {
  useEffect(() => {
    const video = ref.current;
    if (!video || typeof window === 'undefined') return undefined;
    let timer;
    const start = () => {
      timer = setTimeout(() => {
        video.muted = true;
        video.preload = 'auto';
        const playing = video.play?.();
        if (playing && typeof playing.catch === 'function') playing.catch(() => {});
      }, 1200);
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener('load', start);
    };
  }, [ref]);
}

export default function Landing({ onGetStarted, onLoadSample, authError }) {
  const videoRef = useRef(null);
  useDeferredAutoplay(videoRef);

  return (
    <div className="fc landing">
      <nav className="lp-nav" aria-label="Main">
        <div className="wrap">
          <a className="lp-brand" href="/">
            <img src={logoUrl} alt="FinalCap logo" width="30" height="30" />
            FinalCap
          </a>
          <div className="lp-nav-links">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#examples">Examples</a>
            <a href="#privacy">Privacy</a>
          </div>
          <div className="spacer" />
          <button className="btn-ghost" onClick={onGetStarted}>Sign in</button>
          <button className="btn-primary" onClick={onGetStarted}>Get started free</button>
        </div>
      </nav>

      <header className="hero">
        <div className="wrap">
          <div>
            <div className="eyebrow"><span className="dot" /> AI video editor that runs in your browser</div>
            <h1>Edit video by <span className="grad">describing it.</span></h1>
            <p className="hero-sub">Type what you want: trim, captions, color, speed or format. FinalCap turns your words into FFmpeg edits that run in your browser, so your video stays on your device. No timeline, no learning curve.</p>

            {authError && <div className="auth-error">{authError}</div>}

            <div className="cta-row">
              <button className="btn-primary big" onClick={onGetStarted}>Start editing free</button>
              <button className="btn-secondary" onClick={onLoadSample}><span className="play">▶</span> Try the sample video</button>
            </div>
            <div className="micro-proof">
              <span><span className="ok">✓</span> Free to try</span>
              <span><span className="ok">✓</span> No credit card</span>
              <span><span className="ok">✓</span> No upload to edit</span>
            </div>
          </div>
          <div className="hero-visual" aria-hidden="true">
            <div className="editor-card">
              <div className="ec-video">
                <video ref={videoRef} src={explainerVideoUrl} poster={posterUrl} muted loop playsInline preload="none" width="640" height="360" />
                <span className="tag">preview</span>
              </div>
              <div className="ec-chat">
                <div className="ec-bubble user">Convert this to 9:16 for Reels and add burned-in captions</div>
                <div className="ec-bubble ai"><b>✓ Done</b>: cropped to 1080×1920, captions burned in.</div>
              </div>
            </div>
            <div className="float-card fc-1">
              <div className="ic">💬</div>
              <div>Captions generated<small>Translate to Spanish and more</small></div>
            </div>
            <div className="float-card fc-2">
              <div className="ic">⚙️</div>
              <div>Rendering in your browser…<div className="pbar-mini"><i /></div></div>
            </div>
          </div>
        </div>
      </header>

      <div className="stats">
        <div className="wrap">
          {landingStats.map(([num, label]) => (
            <div className="stat" key={label}>
              <div className="num"><span className="grad">{num}</span></div>
              <div className="lbl">{label}</div>
            </div>
          ))}
        </div>
      </div>

      <section className="block" id="features">
        <div className="wrap">
          <div className="kicker reveal">Features</div>
          <h2 className="sec reveal">An AI video editor you control with chat</h2>
          <p className="sec-sub reveal">FinalCap understands plain language and maps it to real FFmpeg operations.</p>
          <div className="feat-grid">
            {landingFeatures.map(([icon, name, description, example]) => (
              <div className="feat reveal" key={name}>
                <div className="fic">{icon}</div>
                <h3>{name}</h3>
                <p>{description}</p>
                <span className="try">Try: “{example}” →</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="block alt" id="how">
        <div className="wrap">
          <div className="kicker reveal">How it works</div>
          <h2 className="sec reveal">How to edit a video by chat, in three steps</h2>
          <p className="sec-sub reveal">If you can describe it, you can edit it.</p>
          <div className="steps">
            {landingSteps.map(([name, description, example], index) => (
              <div className="step reveal" key={name}>
                <div className="n">{index + 1}</div>
                <h3>{name}</h3>
                <p>{description}</p>
                <div className="eg">{example}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="block" id="examples">
        <div className="wrap">
          <div className="kicker reveal">Examples</div>
          <h2 className="sec reveal">Example prompts: trim, captions, 9:16 and more</h2>
          <p className="sec-sub reveal">Paste any of these into the editor.</p>
          <div className="examples">
            {landingExamples.map(([icon, background, prompt, result]) => (
              <div className="ex reveal" key={prompt}>
                <div className="thumb" style={{ background }}>{icon}<span className="arrow">→</span></div>
                <div className="cap">
                  <div className="q">{prompt}</div>
                  <div className="a">{result}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="block alt" id="privacy">
        <div className="wrap">
          <div className="kicker reveal">Privacy</div>
          <h2 className="sec reveal">A private video editor: your video stays on your device</h2>
          <p className="sec-sub reveal">
            FinalCap reads your file straight from your device. Edits run in your browser with FFmpeg compiled to
            WebAssembly, and captions are transcribed by a speech model that also runs in your browser. To plan an
            edit, the AI receives your typed request and up to four small still frames, never the video file.
            Translating captions sends only the caption text. If a step can't run in your browser, FinalCap asks
            before uploading anything; lyric captions, for example, send only the audio track.
            {' '}<a href="/legal/privacy.html">Read the privacy policy</a>.
          </p>
        </div>
      </section>

      <section className="block" id="iphone">
        <div className="wrap">
          <div className="kicker reveal">iPhone</div>
          <h2 className="sec reveal">FinalCap for iPhone is coming soon to the App Store</h2>
          <p className="sec-sub reveal">The same chat-to-edit workflow, with edits applied on your iPhone.</p>
        </div>
      </section>

      <div className="wrap">
        <div className="cta-band reveal">
          <h2>Your next edit is one sentence away.</h2>
          <p>Open a video, describe your first edit, and download the result. It takes less than a minute, and your video stays on your device.</p>
          <div className="cta-row">
            <button className="btn-primary big" onClick={onGetStarted}>Start editing free</button>
            <button className="btn-secondary" onClick={onLoadSample}>Try with a sample video</button>
          </div>
        </div>
      </div>

      <footer>
        <div className="wrap">
          <span>FinalCap: an AI video editor that runs in your browser.</span>
          <div className="spacer" />
          <a href="/legal/privacy.html">Privacy</a>
          <a href="/legal/terms.html">Terms</a>
          <a href="/legal/licenses.html">Open-source licenses</a>
          <a href="/legal/support.html">Support</a>
        </div>
      </footer>
    </div>
  );
}
