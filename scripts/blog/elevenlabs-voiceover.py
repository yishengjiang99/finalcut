#!/usr/bin/env python3
"""Re-voice a slide/caption video with ElevenLabs (Matilda, eleven_multilingual_v2), one clip per SRT cue.

  python3 scripts/blog/elevenlabs-voiceover.py in.mp4 in.srt outdir/

Steps: SRT cues -> TTS per cue (run ON the grepawk.com server over ssh, so the API key never leaves it and is
never printed) -> trim edge silence, squeeze internal pauses to <=0.30 s -> each cue's video segment
(cue start to next cue start) is time-stretched to lead + speech + 0.28 s gap, so lines never overlap and there
is no dead air -> concat -> compress + gain to -14 LUFS (limiter) -> H.264/AAC MP4 with +faststart, plus a
new SRT and VTT that match the new timing. Old audio is dropped (voice only).

Env: VO_SSH (default root@grepawk server, see blog/AGENTS.md), VO_ENV_FILE (the finalcut app .env on that server),
VO_VOICE (default XrExE9yKIg1WjnnlVkGX = Matilda), VO_LUFS (-14). Needs ffmpeg, numpy, soundfile.
"""
import json, os, re, subprocess, sys, numpy as np, soundfile as sf
SSH = os.environ.get('VO_SSH', 'root@grepawk.com')
ENVF = os.environ.get('VO_ENV_FILE', '/home/finalcut/apps/pages/finalcut/.env')
VOICE = os.environ.get('VO_VOICE', 'XrExE9yKIg1WjnnlVkGX'); LUFS = float(os.environ.get('VO_LUFS', '-14'))
LEAD0, GAP, TAIL, SR = 0.35, 0.28, 0.5, 48000

REMOTE = r'''
import json,os,sys,urllib.request
key=[l.split('=',1)[1].strip().strip('"\'') for l in open(sys.argv[1]) if l.strip().startswith('ELEVENLABS_API_KEY=')][0]
cues=json.load(open('cues.json')); os.makedirs('out',exist_ok=True)
for i,c in enumerate(cues):
    p='out/c%02d.mp3'%(i+1)
    if os.path.exists(p): continue
    body={'text':c['text'],'model_id':'eleven_multilingual_v2','voice_settings':{'stability':0.5,'similarity_boost':0.75,'style':0.15,'use_speaker_boost':True},
      'previous_text':cues[i-1]['text'] if i else None,'next_text':cues[i+1]['text'] if i+1<len(cues) else None}
    r=urllib.request.Request('https://api.elevenlabs.io/v1/text-to-speech/%s?output_format=mp3_44100_128'%sys.argv[2],data=json.dumps(body).encode(),headers={'xi-api-key':key,'Content-Type':'application/json'})
    open(p,'wb').write(urllib.request.urlopen(r,timeout=120).read())
'''

def sh(*a, **k): return subprocess.run(a, check=True, capture_output=True, text=True, **k).stdout
def secs(s): return sum(float(x) * m for x, m in zip(s.replace(',', '.').split(':'), (3600, 60, 1)))
def ts(s, sep): return f"{int(s//3600):02d}:{int(s%3600//60):02d}:{s%60:06.3f}".replace('.', sep)
def dur(p): return float(sh('ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p))

def squeeze(x, maxp=0.30, floor=-42):
    fr = int(0.01 * SR); nf = len(x) // fr
    r = 20 * np.log10(np.sqrt(np.mean(x[:nf*fr].reshape(nf, fr) ** 2, 1)) + 1e-9); sil = r < floor
    keep = np.ones(len(x), bool); i = 0
    while i < nf:
        if sil[i]:
            j = i
            while j < nf and sil[j]: j += 1
            L = (j - i) * 0.01
            if i > 0 and j < nf and L > maxp:
                cut = int((L - maxp) * SR); mid = (i + j) // 2 * fr; keep[mid - cut//2: mid - cut//2 + cut] = False
            i = j
        else: i += 1
    nz = np.where(~sil)[0]; keep[:max(0, nz[0] - 2) * fr] = False; keep[(nz[-1] + 4) * fr:] = False
    return x[keep]

def main(src, srt, out):
    os.makedirs(out, exist_ok=True)
    cues = []
    for b in re.split(r'\n\s*\n', open(srt).read().strip()):
        l = b.splitlines(); a, c = l[1].split(' --> ')
        cues.append({'start': secs(a), 'end': secs(c), 'text': ' '.join(l[2:])})
    json.dump(cues, open(f'{out}/cues.json', 'w'))
    rd = '/tmp/el-vo-' + os.path.basename(os.path.abspath(out))
    open(f'{out}/tts_remote.py', 'w').write(REMOTE)
    sh('ssh', SSH, f'mkdir -p {rd}'); sh('scp', '-q', f'{out}/cues.json', f'{out}/tts_remote.py', f'{SSH}:{rd}/')
    sh('ssh', SSH, f'cd {rd} && python3 tts_remote.py {ENVF} {VOICE}')
    sh('scp', '-q', '-r', f'{SSH}:{rd}/out', out)
    for i, c in enumerate(cues):
        x = np.frombuffer(subprocess.run(['ffmpeg', '-v', 'error', '-i', f'{out}/out/c{i+1:02d}.mp3', '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'],
                                         capture_output=True, check=True).stdout, np.float32).astype(np.float64)
        x = squeeze(x); sf.write(f'{out}/c{i+1:02d}.wav', x, SR); c['speech'] = len(x) / SR
    T = dur(src); t = 0; segs = []; subs = []
    for i, x in enumerate(cues):
        a = 0 if i == 0 else x['start']; b = cues[i+1]['start'] if i + 1 < len(cues) else T
        lead = LEAD0 if i == 0 else 0; n = lead + x['speech'] + (TAIL if i + 1 == len(cues) else GAP)
        subs.append((t + lead, t + lead + x['speech'], x['text'])); segs.append((a, b, n)); t += n
    fc = [f"[0:v]trim={a}:{b},setpts=(PTS-STARTPTS)*{n/(b-a):.6f},fps=30,trim=duration={n:.4f}[v{i}]" for i, (a, b, n) in enumerate(segs)]
    fc.append(''.join(f'[v{i}]' for i in range(len(segs))) + f'concat=n={len(segs)}:v=1:a=0[v]')
    ins = []
    for i, s in enumerate(subs):
        ins += ['-i', f'{out}/c{i+1:02d}.wav']; fc.append(f'[{i+1}:a]adelay={int(s[0]*1000)}:all=1[a{i}]')
    fc.append(''.join(f'[a{i}]' for i in range(len(subs))) + f'amix=inputs={len(subs)}:normalize=0,apad,atrim=0:{t:.3f}[a]')
    open(f'{out}/fc.txt', 'w').write(';\n'.join(fc))
    sh('ffmpeg', '-y', '-v', 'error', '-i', src, *ins, '-filter_complex_script', f'{out}/fc.txt', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264',
       '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', str(SR), '-ac', '1', f'{out}/pre.mkv')
    mux(f'{out}/pre.mkv', f'{out}/final.mp4')
    open(f'{out}/final.srt', 'w').write('\n'.join(f"{i+1}\n{ts(a,',')} --> {ts(b,',')}\n{x}\n" for i, (a, b, x) in enumerate(subs)))
    open(f'{out}/final.vtt', 'w').write('WEBVTT\n\n' + '\n'.join(f"{ts(a,'.')} --> {ts(b,'.')}\n{x}\n" for a, b, x in subs))
    gaps = [round(subs[i+1][0] - subs[i][1], 2) for i in range(len(subs) - 1)]
    print(json.dumps({'duration': round(dur(f'{out}/final.mp4'), 2), 'max_gap_between_cues': max(gaps),
                      'max_stretch': round(max(n/(b-a) for a, b, n in segs), 2), 'lufs': lufs(f'{out}/final.mp4')}))

C = 'acompressor=threshold=-22dB:ratio=3:attack=5:release=80:makeup=1'
def lufs(p, af=None):
    e = subprocess.run(['ffmpeg', '-hide_banner', '-i', p, '-vn', '-af', (af + ',' if af else '') + 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', e)[-1])
def mux(src, dst):
    g = LUFS - lufs(src, C)
    sh('ffmpeg', '-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af',
       f'{C},volume={g:.2f}dB,alimiter=limit=0.84:attack=2:release=50:level=false,aresample={SR}', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', dst)

if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--mux': mux(sys.argv[2], sys.argv[3]); print(lufs(sys.argv[3]))
    elif len(sys.argv) == 4: main(*sys.argv[1:])
    else: sys.exit(__doc__)
