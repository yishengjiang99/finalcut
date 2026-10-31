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
    title: 'Add subtitles to video online, with auto captions burned in | FinalCap',
    description: 'Add subtitles to a video online by typing one sentence. FinalCap transcribes the speech and burns the captions in, or gives you SRT and VTT files instead.',
    h1: 'Add subtitles to a video and burn them in',
    lede: 'FinalCap is a chat-to-edit AI video editor. Open a video, type "Generate captions for this video", and it transcribes the speech, writes the subtitles and burns (hardcodes) them into the frames. To get a separate subtitle file instead, ask for SRT or VTT only. The video stays unchanged.',
    steps: [
      ['Open your video', 'Sign in with Google and open a video file from your computer. It opens in the browser editor.'],
      ['Ask for captions in plain English', 'Type one of these prompts, or your own wording:', [
        'Generate captions for this video',
        'Add yellow captions at the top of the video',
        'Generate captions but don\'t burn them in, I just want the SRT file',
      ]],
      ['Check and download', 'Play the result in the editor, then download the captioned video. The SRT file is offered as a download too.'],
    ],
    options: [
      'Burned-in (hardcoded) captions, or soft subtitles only (SRT and VTT files, video unchanged).',
      'Three caption styles: default, white text on a black box, or yellow text.',
      'Bottom or top of the frame.',
      'Spoken language auto-detected, or name it in the prompt ("the audio is in French").',
      'Captioning again replaces the earlier captions instead of stacking a second set on top.',
    ],
    privacy: [
      'FinalCap transcribes speech on your device. A speech-recognition model downloads once and runs in your browser (WebGPU or WebAssembly), so the audio is not uploaded for this step.',
      'Your chat prompts are sent to FinalCap\'s server, where the AI decides which edit to run.',
      'The captions are burned in with FFmpeg in your browser. If your browser can\'t do that step, FinalCap asks before uploading the video to burn them on the server; say no and you get the subtitle files instead.',
      'Translating the captions (see the translation guide) sends the caption text to the server.',
    ],
    faq: [
      ['Can I get an SRT file instead of burned-in subtitles?', 'Yes. Say you don\'t want them burned in ("just the SRT file") and FinalCap returns SRT and VTT subtitle files and leaves the video as it was. When it does burn them in, the SRT is offered as a download as well.'],
      ['Which languages can it caption?', 'The speech model detects the spoken language automatically. If detection picks the wrong one, name the language in your prompt.'],
      ['Can I upload my own SRT file and burn it in?', 'Not today. FinalCap creates the captions from the video\'s audio; it does not import existing subtitle files.'],
      ['Do I need to install anything?', 'No. FinalCap runs in a desktop browser. The first time you caption a video the speech model downloads, which takes a moment; after that it is cached.'],
      ['Does it work on photos or audio-only files?', 'No. Captions are for videos with speech. For songs, use lyric captions instead.'],
    ],
    prompt: 'Generate captions for this video',
    signinNote: SIGNIN_NOTE,
  },
  {
    slug: 'translate-subtitles',
    nav: 'Translate subtitles',
    title: 'Translate video subtitles online with bilingual AI captions | FinalCap',
    description: 'Add translated subtitles to a video with one prompt. FinalCap transcribes the speech, translates the captions and burns in both languages, or exports SRTs.',
    h1: 'Translate subtitles and add bilingual captions to a video',
    lede: 'Need English subtitles on a Spanish video, or Spanish subtitles on an English one? In FinalCap you ask for it in one sentence. It transcribes the speech, translates every caption line and burns both languages into the video, with the translation on top and the original underneath.',
    steps: [
      ['Open your video', 'Sign in with Google and open a video file from your computer.'],
      ['Say which language you want', 'Type one of these prompts, or your own wording:', [
        'Generate captions and translate them to Spanish',
        'Add English subtitles to this video',
        'Translate the captions to Japanese but don\'t burn them in',
      ]],
      ['Check and download', 'Play the bilingual result, then download the video. You also get the original SRT and the translated SRT as downloads.'],
    ],
    options: [
      'Bilingual burn-in: the translated line on top, the original line below it.',
      'Or soft subtitles only: an original SRT and a translated SRT, with the video unchanged.',
      'Name the target language in plain words ("Spanish", "Chinese") or with a code (es, zh).',
      'Same styles and positions as regular captions: default, white on black or yellow; bottom or top.',
      'Translated lines that would only repeat the original are dropped, so the screen isn\'t doubled up.',
    ],
    privacy: [
      'FinalCap transcribes speech on your device, as with regular captions. The audio is not uploaded for transcription.',
      'Translation runs on FinalCap\'s server today. The caption text (not the audio or the video) is sent there to be translated.',
      'Your chat prompts are sent to the server, where the AI decides which edit to run.',
      'Burn-in runs with FFmpeg in your browser; if it can\'t, FinalCap asks before uploading the video to the server.',
    ],
    faq: [
      ['Which languages can it translate to?', 'Name the language you want in the prompt. Common targets include English, Spanish, French, German, Japanese and Chinese; the translation is done by an AI model on our server.'],
      ['Where do the two languages appear on screen?', 'With burned-in captions, the translation sits on top and the original language below it. Ask for "top" to move the captions to the top of the frame.'],
      ['Can I get just the translated subtitle file?', 'Yes. Ask for the captions without burning them in and you get both the original and the translated SRT files.'],
      ['Can I translate an existing SRT file?', 'Not today. FinalCap translates the captions it creates from the video\'s audio.'],
      ['Is it the same as lyric captions?', 'No. Translated subtitles are for speech. For a song or music video, use lyric captions: they identify the song and correct the lyrics before translating.'],
    ],
    prompt: 'Generate captions and translate them to Spanish',
    signinNote: SIGNIN_NOTE,
  },
  {
    slug: 'add-lyrics-to-video',
    nav: 'Add lyrics to a video',
    title: 'Add lyrics to video automatically, with translation | FinalCap',
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
      'You choose the translation language; if you don\'t name one, FinalCap asks.',
      'For songs it identifies the track and corrects the lyrics; for talking it only fixes obvious mistakes.',
      'Ask for the captions higher or lower, or for a bigger or smaller font.',
    ],
    privacy: [
      'Lyric captions use FinalCap\'s server today. The audio track (never the video) is uploaded to transcribe the vocals, identify the song and translate the lines.',
      'FinalCap asks before that upload; say no and nothing is sent.',
      'The captions are burned into the video with FFmpeg in your browser. If your browser can\'t do that step, FinalCap asks before uploading the video for it.',
      'Your chat prompts are sent to the server, where the AI decides which edit to run.',
    ],
    faq: [
      ['Does it work if I don\'t know the song?', 'Yes. FinalCap transcribes what is sung and tries to identify the song to correct the words; you don\'t have to tell it the title.'],
      ['Can I translate lyrics to English?', 'Yes. Say which language you want ("with an English translation") and every lyric line gets an English line under it.'],
      ['Can I get the lyrics without a translation?', 'Lyric captions are always two lines (original plus translation). For single-language subtitles, use regular captions instead.'],
      ['Can I make a lyric video from an audio file?', 'No. Lyric captions are added to a video; they don\'t create a video from an MP3.'],
      ['Is my video uploaded?', 'Not for the lyrics: only the audio track is uploaded, after you agree. The video is uploaded only if your browser can\'t burn in the captions and you agree to that too.'],
    ],
    prompt: 'Add lyric captions to this video with an English translation',
    signinNote: SIGNIN_NOTE,
  },
  {
    slug: 'edit-video-without-uploading',
    nav: 'Edit video without uploading',
    title: 'Edit video without uploading: a private AI editor in your browser | FinalCap',
    description: 'Edit video without uploading it. FinalCap runs FFmpeg and Whisper in your browser, so your file stays on your device while you trim, caption and resize.',
    h1: 'Edit video without uploading your file',
    lede: 'FinalCap is a private AI video editor that runs in your browser. You describe the edit in plain English, the AI returns a structured tool call, and FFmpeg in your browser runs it on your device, so the video file is not uploaded for normal edits.',
    steps: [
      ['Open your video', 'Sign in with Google and open a video file from your computer. Opening the file does not upload it; the browser reads it from your device.'],
      ['Describe the edit in plain English', 'Type one of these prompts, or your own wording:', [
        'Resize this video to 9:16 and add captions',
        'Trim the first five seconds and boost the saturation',
        'Make it 2x faster and convert it to WebM',
      ]],
      ['Check and download', 'FFmpeg renders the edit in your browser. Play the result in the editor, then download the finished file.'],
    ],
    options: [
      'Trim, cut and join clips, with transitions between them.',
      'Resize and crop to 9:16 for Reels, TikTok and Shorts, 1:1 for feeds, or 16:9 for YouTube.',
      'Captions transcribed on your device, burned in or exported as SRT and VTT files, with translation if you ask for it.',
      'Speed, volume, fades, loudness, color, text overlays, rotation and format conversion to MP4, WebM, MOV or MKV.',
    ],
    privacy: [
      'For normal edits your video file is not uploaded. Edits run with FFmpeg compiled to WebAssembly in your browser, and captions are transcribed by default with a Whisper speech model that also runs in your browser.',
      'To plan an edit, the AI receives your typed request and up to four small still frames from the video, never the video file itself.',
      'Translating captions sends only the caption text to the server. Lyric captions send only the audio track, and only after you agree.',
      'If a step cannot run in your browser, FinalCap asks before uploading anything to do it on the server. The default answer is no.',
    ],
    faq: [
      ['Does FinalCap upload my video?', 'No, not for normal edits. The video file stays on your device and FFmpeg runs the edit in your browser. FinalCap asks for explicit confirmation before any media upload, and the only routine exception is lyric captions, which send the audio track (never the video) after you agree.'],
      ['What does the AI see?', 'Your typed request and up to four small still frames from the video, so it can plan the edit. It never receives the video file, and it can only choose from the edits FinalCap knows how to run, with the parameters those edits accept.'],
      ['How do captions work without uploading?', 'A Whisper speech model downloads once, runs in your browser (WebGPU or WebAssembly) and transcribes the audio on your device. Translating the captions sends only the caption text to the server.'],
      ['What if an edit cannot run in my browser?', 'FinalCap asks before uploading anything to do that step on the server. If you say no, the edit does not run that way; for captions you can take the SRT and VTT subtitle files instead of a burned-in video.'],
      ['Is FinalCap free?', 'It is free to try: the sample video works with no sign-in and no subscription. Editing your own videos needs a Google sign-in and a FinalCap subscription, and nothing runs until you press Send.'],
    ],
    prompt: 'Resize this video to 9:16 and add captions',
    signinNote: SIGNIN_NOTE,
  },
  {
    slug: 'about',
    nav: 'About FinalCap',
    title: 'About FinalCap | Private AI Video Editor That Runs in Your Browser',
    description: 'FinalCap is a chat-driven video editor that runs FFmpeg and Whisper in your browser. Built so your video stays on your device. Learn how it works here.',
    h1: 'About FinalCap: the editor where the model never touches your video',
    lede: 'FinalCap is a chat-driven AI video editor for the browser and iPhone. Most AI video tools ask you to upload your file to their server, or generate new video from scratch. FinalCap does neither for normal edits: you describe the edit, and your own device applies it to your own file.',
    stepsHeading: 'How FinalCap works, in three steps',
    steps: [
      ['You describe the edit', 'Open a video and type what you want in plain English: a trim, captions, a resize to 9:16, a color or speed change.'],
      ['The model picks a tool', 'An AI model on the server reads your request and answers with one structured tool call: a named edit with checked parameters. It never receives your video file, so it cannot upload, keep or alter it.'],
      ['Your device runs it', 'The browser runs the tool call with FFmpeg compiled to WebAssembly; the iPhone app runs it with AVFoundation. You preview the result, keep editing, or download the file.'],
    ],
    optionsHeading: 'Design principles',
    options: [
      'Local by default: editing and caption transcription run on the device, not on a server.',
      'A constrained model: the AI can only request edits FinalCap already knows how to run, with parameters those edits accept.',
      'Transparency: every guide and the privacy policy state what is sent, what stays local, and what asks first.',
      'Practical edits: trim, captions, social formats, color, speed and export, done well, instead of generative effects.',
    ],
    sections: [
      ['Who built FinalCap', [
        'FinalCap is designed and built by Yisheng Jiang, a software engineer who previously worked as a Meta contractor, and released under the GrepAwk name. The same developer makes ProTune AI Camera and AI Music Radar.',
        'Support and contact options are on the support page linked in the footer; the privacy policy linked below states how FinalCap handles data.',
      ]],
      ['FinalCap on the web and on iPhone', [
        'On the web, FinalCap runs in a desktop browser at grepawk.com, with no install. On iPhone, the FinalCap app (apps.apple.com, app id 6815060815) offers the same chat-to-edit workflow, with edits applied on the phone.',
        'Both versions share the same rule: the video file is not uploaded for normal edits, and any step that needs a server asks first.',
      ]],
    ],
    privacyHeading: 'The FinalCap privacy model',
    privacy: [
      'FinalCap does not upload your video file for normal edits. That is the core constraint the product is built around.',
      'What is sent is small and named: your typed request and up to four small still frames to plan an edit, and caption text when you ask for a translation.',
      'Captions are transcribed by default with Whisper running on your device, so the audio is not uploaded for transcription.',
      'If a step cannot run on your device, FinalCap asks for explicit confirmation before uploading any media, and lyric captions send only the audio track.',
    ],
    faq: [
      ['Who makes FinalCap?', 'Yisheng Jiang, a software engineer (formerly a Meta contractor), building under the GrepAwk name. He also makes ProTune AI Camera and AI Music Radar.'],
      ['Is FinalCap a generative AI video tool?', 'No. FinalCap applies deterministic edits (trim, resize, captions, color, speed, format) to your own video with FFmpeg or AVFoundation. It does not generate new footage.'],
      ['Why does FinalCap not upload videos like other editors?', 'Because the edit can run where the file already is. Modern browsers can run FFmpeg and Whisper locally, so uploading the whole video is a choice, not a requirement, and FinalCap chooses not to for normal edits.'],
      ['Where can I use FinalCap?', 'In a desktop browser at grepawk.com, and on iPhone through the FinalCap app on the App Store. The sample video on the home page works with no sign-in.'],
      ['Is FinalCap free?', 'It is free to try: the sample video works with no sign-in and no subscription. Editing your own videos needs a Google sign-in and a FinalCap subscription.'],
    ],
    prompt: 'Trim the first five seconds and make it 9:16 for Reels',
    signinNote: 'The sample clip needs neither a sign-in nor a subscription; editing your own video needs a Google sign-in and a FinalCap subscription, and nothing runs until you press Send.',
  },
];
