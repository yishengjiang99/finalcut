// Content for the static SEO task pages (scripts/build-task-pages.mjs -> dist/<slug>.html).
// Every claim here must match the app: generate_captions and lyric_captions in src/tools.js and
// their browser paths in src/toolFunctions.js. Example prompts are ones the chat maps to those
// tools (the same wording as the app's sampleCommands/captionCommands and tool descriptions).
// Keyword groups: finalcut-marketing/long-tail-keywords.md.

export const SITE = 'https://grepawk.com';

const SIGNIN_NOTE = 'Editing your own video needs a Google sign-in and a FinalCap subscription, and nothing runs until you press Send. The sample clip needs neither; it is an animated short with music and no dialogue or vocals, so use it to see how chat editing works rather than to test captions.';

export const pages = [
  {
    slug: 'add-subtitles',
    nav: 'Add subtitles to a video',
    title: 'Add Subtitles to Video Online: Auto Captions, Burned In | FinalCap',
    description: 'Add subtitles to a video online by typing one sentence. FinalCap transcribes the speech and burns the captions in, or gives you SRT and VTT files instead.',
    h1: 'Add subtitles to a video and burn them in',
    lede: 'FinalCap is a chat-to-edit AI video editor. Open a video, type “Generate captions for this video”, and it transcribes the speech, writes the subtitles and burns (hardcodes) them into the frames. Prefer a separate subtitle file? Ask for SRT/VTT only and the video is left untouched.',
    steps: [
      ['Open your video', 'Sign in with Google and open a video file from your computer. It opens in the browser editor.'],
      ['Ask for captions in plain English', 'Type one of these prompts, or your own wording:', [
        'Generate captions for this video',
        'Add yellow captions at the top of the video',
        'Generate captions but don’t burn them in, I just want the SRT file',
      ]],
      ['Check and download', 'Play the result in the editor, then download the captioned video. The SRT file is offered as a download too.'],
    ],
    options: [
      'Burned-in (hardcoded) captions, or soft subtitles only (SRT and VTT files, video unchanged).',
      'Three caption styles: default, white text on a black box, or yellow text.',
      'Bottom or top of the frame.',
      'Spoken language auto-detected, or name it in the prompt (“the audio is in French”).',
      'Captioning again replaces the earlier captions instead of stacking a second set on top.',
    ],
    privacy: [
      'Speech is transcribed on your device: a speech-recognition model downloads once and runs in your browser (WebGPU or WebAssembly), so the audio is not uploaded for this step.',
      'Your chat prompts are sent to FinalCap’s server, where the AI decides which edit to run.',
      'The captions are burned in with FFmpeg in your browser. If your browser can’t do that step, FinalCap asks before uploading the video to burn them on the server; say no and you get the subtitle files instead.',
      'Translating the captions (see the translation guide) sends the caption text to the server.',
    ],
    faq: [
      ['Can I get an SRT file instead of burned-in subtitles?', 'Yes. Say you don’t want them burned in (“just the SRT file”) and FinalCap returns SRT and VTT subtitle files and leaves the video as it was. When it does burn them in, the SRT is offered as a download as well.'],
      ['Which languages can it caption?', 'The speech model detects the spoken language automatically. If detection picks the wrong one, name the language in your prompt.'],
      ['Can I upload my own SRT file and burn it in?', 'Not today. FinalCap creates the captions from the video’s audio; it does not import existing subtitle files.'],
      ['Do I need to install anything?', 'No. FinalCap runs in a desktop browser. The first time you caption a video the speech model downloads, which takes a moment; after that it is cached.'],
      ['Does it work on photos or audio-only files?', 'No. Captions are for videos with speech. For songs, use lyric captions instead.'],
    ],
    prompt: 'Generate captions for this video',
    signinNote: SIGNIN_NOTE,
  },
  {
    slug: 'translate-subtitles',
    nav: 'Translate subtitles',
    title: 'Translate Video Subtitles Online: Bilingual AI Captions | FinalCap',
    description: 'Add translated subtitles to a video with one prompt. FinalCap transcribes the speech, translates the captions and burns in both languages, or exports SRTs.',
    h1: 'Translate subtitles and add bilingual captions to a video',
    lede: 'Need English subtitles on a Spanish video, or Spanish subtitles on an English one? In FinalCap you ask for it in one sentence. It transcribes the speech, translates every caption line with AI and burns both languages into the video: the translation on top, the original underneath.',
    steps: [
      ['Open your video', 'Sign in with Google and open a video file from your computer.'],
      ['Say which language you want', 'Type one of these prompts, or your own wording:', [
        'Generate captions and translate them to Spanish',
        'Add English subtitles to this video',
        'Translate the captions to Japanese but don’t burn them in',
      ]],
      ['Check and download', 'Play the bilingual result, then download the video. You also get the original SRT and the translated SRT as downloads.'],
    ],
    options: [
      'Bilingual burn-in: the translated line on top, the original line below it.',
      'Or soft subtitles only: an original SRT and a translated SRT, with the video unchanged.',
      'Name the target language in plain words (“Spanish”, “Chinese”) or with a code (es, zh).',
      'Same styles and positions as regular captions: default, white on black or yellow; bottom or top.',
      'Translated lines that would only repeat the original are dropped, so the screen isn’t doubled up.',
    ],
    privacy: [
      'Speech is transcribed on your device, as with regular captions: the audio is not uploaded for transcription.',
      'Translation runs on FinalCap’s server today: the caption text (not the audio or the video) is sent there to be translated.',
      'Your chat prompts are sent to the server, where the AI decides which edit to run.',
      'Burn-in runs with FFmpeg in your browser; if it can’t, FinalCap asks before uploading the video to the server.',
    ],
    faq: [
      ['Which languages can it translate to?', 'Name the language you want in the prompt. Common targets include English, Spanish, French, German, Japanese and Chinese; the translation is done by an AI model on our server.'],
      ['Where do the two languages appear on screen?', 'With burned-in captions, the translation sits on top and the original language below it. Ask for “top” to move the captions to the top of the frame.'],
      ['Can I get just the translated subtitle file?', 'Yes. Ask for the captions without burning them in and you get both the original and the translated SRT files.'],
      ['Can I translate an existing SRT file?', 'Not today. FinalCap translates the captions it creates from the video’s audio.'],
      ['Is it the same as lyric captions?', 'No. Translated subtitles are for speech. For a song or music video, use lyric captions: they identify the song and correct the lyrics before translating.'],
    ],
    prompt: 'Generate captions and translate them to Spanish',
    signinNote: SIGNIN_NOTE,
  },
  {
    slug: 'add-lyrics-to-video',
    nav: 'Add lyrics to a video',
    title: 'Add Lyrics to Video Automatically, With Translation | FinalCap',
    description: 'Add song lyrics to a video automatically. FinalCap hears the vocals, matches the song to fix the words, translates each line and burns both into the video.',
    h1: 'Add lyrics to a video automatically, with a translation under each line',
    lede: 'Lyric captions turn a music video, a cover or a dance clip into a karaoke-style bilingual lyrics video. FinalCap transcribes the sung audio with word timing, identifies the song and fixes misheard lyrics against the published lyrics, translates each line into the language you choose, and burns two-line captions into the video.',
    steps: [
      ['Open your video', 'Sign in with Google and open a video with a song in it.'],
      ['Ask for lyrics and a translation language', 'Type one of these prompts, or your own wording:', [
        'Add lyric captions to this video with an English translation',
        'Subtitle the song in Chinese',
        'Translate the lyrics on the video to Spanish',
      ]],
      ['Allow the audio upload, then download', 'FinalCap asks before it uploads the audio track (the privacy note below explains why). Then play the result and download the video.'],
    ],
    options: [
      'Two lines per caption: the original lyric on top, the translation below it, about 20% up from the bottom of the frame.',
      'You choose the translation language; if you don’t name one, FinalCap asks.',
      'For songs it identifies the track and corrects the lyrics; for talking it only fixes obvious mistakes.',
      'Ask for the captions higher or lower, or for a bigger or smaller font.',
    ],
    privacy: [
      'Lyric captions use FinalCap’s server today: the audio track (never the video) is uploaded to transcribe the vocals, identify the song and translate the lines.',
      'FinalCap asks before that upload; say no and nothing is sent.',
      'The captions are burned into the video with FFmpeg in your browser. If your browser can’t do that step, FinalCap asks before uploading the video for it.',
      'Your chat prompts are sent to the server, where the AI decides which edit to run.',
    ],
    faq: [
      ['Does it work if I don’t know the song?', 'Yes. FinalCap transcribes what is sung and tries to identify the song to correct the words; you don’t have to tell it the title.'],
      ['Can I translate lyrics to English?', 'Yes. Say which language you want (“with an English translation”) and every lyric line gets an English line under it.'],
      ['Can I get the lyrics without a translation?', 'Lyric captions are always two lines (original plus translation). For single-language subtitles, use regular captions instead.'],
      ['Can I make a lyric video from an audio file?', 'No. Lyric captions are added to a video; they don’t create a video from an MP3.'],
      ['Is my video uploaded?', 'Not for the lyrics: only the audio track is uploaded, after you agree. The video is uploaded only if your browser can’t burn in the captions and you agree to that too.'],
    ],
    prompt: 'Add lyric captions to this video with an English translation',
    signinNote: SIGNIN_NOTE,
  },
];
