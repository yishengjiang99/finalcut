#!/usr/bin/env python3
"""FinalCap App Store screenshots from public/BigBuckBunny.mp4.

Writes docs/asc/screenshots/en-US/iphone-69-01-chat-the-edit.png
and ipad-13-05-color-on-command.png — same title style as photo-recipes.
"""
from __future__ import annotations
import subprocess, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
BBB = Path('/tmp/bbb/BigBuckBunny.mp4')
for p in [HERE, *HERE.parents]:
    cand = p / 'public' / 'BigBuckBunny.mp4'
    if cand.exists():
        BBB = cand; break

SIZES = {'iphone-69': (1320, 2868), 'ipad-13': (2064, 2752)}
INK=(245,245,247); MUTED=(164,164,170); ACCENT=(255,196,72)
USER_BUBBLE=(255,196,72); USER_TEXT=(18,16,12); ASSIST=(36,36,40)
CARD=(22,22,26); EDGE=(58,58,64); BG_TOP=(28,28,32); BG_BOT=(10,10,12)

SHOTS = [
    ('01-chat-the-edit','Chat the edit.\nType the cut.','Say the trim, title, or look','Trim the first second','Cut. Preview is ready.'),
    ('02-say-the-trim','Say the trim.\nWatch it happen.','Cut, crop, speed, or fade','Cut the first three seconds','Trimmed to 2s. Undo anytime.'),
    ('03-see-it-first','See it first.\nThen save it.','Preview every change','Compare with the original','Hold to see before / after.'),
    ('04-add-a-title','Add a title.\nOn the clip.','Text lands on the preview','Add a title that says Day One','Title on the preview.'),
    ('05-color-on-command','Color on command.\nWarmth and looks.','Looks, warmth, contrast','Make it warmer','Warm look applied.'),
    ('06-save-to-photos','Save to Photos.\nStays on device.','Export without an upload','Save this to Photos','Saved. Nothing was uploaded.'),
]

def _font_path(weight):
    root = Path('/usr/share/fonts/SlidesCarnival/google/Inter/static')
    names = {'ExtraBold':'Inter_28pt-ExtraBold.ttf','Bold':'Inter_28pt-Bold.ttf','SemiBold':'Inter_24pt-SemiBold.ttf'}
    p = root / names[weight]
    if p.exists(): return str(p)
    local = HERE / 'fonts' / f'Inter-{weight}.ttf'
    if local.exists(): return str(local)
    local.parent.mkdir(parents=True, exist_ok=True)
    gh = {
        'ExtraBold':'https://github.com/rsms/inter/raw/master/docs/font-files/Inter-ExtraBold.otf',
        'Bold':'https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Bold.otf',
        'SemiBold':'https://github.com/rsms/inter/raw/master/docs/font-files/Inter-SemiBold.otf',
    }
    try:
        subprocess.check_call(['curl','-fsSL','-o',str(local),gh[weight]])
        if local.exists() and local.stat().st_size>1000: return str(local)
    except Exception:
        pass
    dv=Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
    if dv.exists(): return str(dv)
    raise FileNotFoundError(weight)

_fonts={}
def font(size, weight='ExtraBold'):
    key=(size,weight)
    if key not in _fonts:
        _fonts[key]=ImageFont.truetype(_font_path(weight), size)
    return _fonts[key]

def dark_bg(W,H):
    img=Image.new('RGB',(W,H),BG_BOT); px=img.load()
    for y in range(H):
        t=y/max(H-1,1)
        c=tuple(int(BG_TOP[i]*(1-t)+BG_BOT[i]*t) for i in range(3))
        for x in range(W): px[x,y]=c
    return img

def extract_frames(n=6):
    if not BBB.exists(): raise SystemExit(f'missing sample video: {BBB}')
    frames=[]; times=[0.4,1.1,1.8,2.6,3.4,4.2]
    with tempfile.TemporaryDirectory() as td:
        for i,t in enumerate(times[:n]):
            out=Path(td)/f'f{i}.jpg'
            subprocess.check_call(['ffmpeg','-y','-ss',f'{t:.2f}','-i',str(BBB),'-frames:v','1','-q:v','2',str(out)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            frames.append(Image.open(out).convert('RGB'))
    return frames

def cover(src,w,h,warm=0.0):
    img=src.copy(); scale=max(w/img.width, h/img.height)
    img=img.resize((max(1,int(img.width*scale)), max(1,int(img.height*scale))), Image.LANCZOS)
    x=(img.width-w)//2; y=(img.height-h)//2
    img=img.crop((x,y,x+w,y+h))
    if warm:
        img=ImageEnhance.Color(img).enhance(1.0+warm)
        img=ImageEnhance.Contrast(img).enhance(1.08)
        img=Image.blend(img, Image.new('RGB', img.size, (255,170,60)), warm*0.28)
    return img

def rounded(size,r):
    m=Image.new('L',size,0); ImageDraw.Draw(m).rounded_rectangle((0,0,size[0]-1,size[1]-1),r,fill=255); return m

def draw_caption(canvas, hero, sub, scale):
    d=ImageDraw.Draw(canvas); W=canvas.width
    f=font(round(108*scale)); y=round(96*scale); lh=round(122*scale)
    for line in hero.split('\n'):
        w=d.textlength(line, font=f); d.text(((W-w)/2,y), line, font=f, fill=INK); y+=lh
    if sub:
        fs=font(round(46*scale),'SemiBold'); y+=round(8*scale)
        w=d.textlength(sub, font=fs); d.text(((W-w)/2,y), sub, font=fs, fill=ACCENT); y+=round(64*scale)
    return y

def wrap(d,text,f,max_w):
    words=text.split(); lines,cur=[], ''
    for wd in words:
        t=(cur+' '+wd).strip()
        if d.textlength(t, font=f)<=max_w: cur=t
        else:
            if cur: lines.append(cur)
            cur=wd
    if cur: lines.append(cur)
    return lines or [text]

def mock_screen(frame, idx, sw, sh):
    img=Image.new('RGB',(sw,sh),(16,16,18)); d=ImageDraw.Draw(img); s=sw/940
    d.text((round(28*s), round(22*s)), 'FinalCap', font=font(round(28*s),'Bold'), fill=INK)
    d.text((sw-round(120*s), round(26*s)), 'Export', font=font(round(24*s),'SemiBold'), fill=ACCENT)
    pw,ph=sw-round(32*s), round(sh*0.38)
    preview=cover(frame,pw,ph,warm=0.22 if idx==4 else 0.0)
    if idx==3:
        pd=ImageDraw.Draw(preview); tf=font(round(54*s),'ExtraBold'); label='DAY ONE'
        tw=pd.textlength(label, font=tf); tx,ty=(pw-tw)/2, ph*0.72
        pd.rectangle((tx-18,ty-8,tx+tw+18,ty+round(64*s)), fill=(0,0,0))
        pd.text((tx,ty), label, font=tf, fill=(255,255,255))
    if idx==2:
        pd=ImageDraw.Draw(preview)
        pd.rounded_rectangle((16,16,16+round(170*s),16+round(48*s)),20,fill=(0,0,0))
        pd.text((28,24),'AFTER', font=font(round(22*s),'Bold'), fill=ACCENT)
    img.paste(preview,(round(16*s), round(70*s)))
    bar_y=round(70*s)+ph+round(10*s)
    d.rounded_rectangle((round(16*s),bar_y,sw-round(16*s),bar_y+round(8*s)),4,fill=(50,50,54))
    d.rounded_rectangle((round(16*s),bar_y,round(16*s)+int((sw-32*s)*0.45),bar_y+round(8*s)),4,fill=ACCENT)
    user,assistant=SHOTS[idx][3], SHOTS[idx][4]
    y=bar_y+round(36*s); fb=font(round(28*s),'SemiBold'); max_w=sw-round(160*s)
    def bubble(text,fill,tfill,right):
        nonlocal y
        lines=wrap(d,text,fb,max_w); lh=round(36*s); pad=round(22*s)
        bw=max(d.textlength(ln, font=fb) for ln in lines)+pad*2
        bh=pad+len(lines)*lh+pad//2
        x=sw-round(24*s)-bw if right else round(24*s)
        d.rounded_rectangle((x,y,x+bw,y+bh), round(22*s), fill=fill)
        ty=y+pad//2+2
        for ln in lines:
            d.text((x+pad,ty), ln, font=fb, fill=tfill); ty+=lh
        y+=bh+round(16*s)
    bubble(user,USER_BUBBLE,USER_TEXT,True); bubble(assistant,ASSIST,INK,False)
    if idx==0:
        chips=['Generate captions','Red filter','Speed up 2\u00d7']; cf=font(round(22*s),'Bold'); x=round(24*s)
        for lab in chips:
            tw=d.textlength(lab, font=cf)+round(36*s)
            d.rounded_rectangle((x,y,x+tw,y+round(48*s)),24,outline=EDGE,width=2)
            d.text((x+round(18*s), y+round(12*s)), lab, font=cf, fill=INK); x+=tw+round(12*s)
    if idx==5:
        for lab,fill,tfill in (('Save to Photos',ACCENT,USER_TEXT),('Save to Files',CARD,INK)):
            d.rounded_rectangle((round(48*s),y,sw-round(48*s),y+round(64*s)),32,fill=fill,outline=EDGE)
            tw=d.textlength(lab, font=font(round(28*s),'Bold'))
            d.text(((sw-tw)/2, y+round(16*s)), lab, font=font(round(28*s),'Bold'), fill=tfill); y+=round(80*s)
    d.rounded_rectangle((round(20*s), sh-round(90*s), sw-round(20*s), sh-round(28*s)),28,outline=EDGE,width=2)
    d.text((round(40*s), sh-round(72*s)), 'Tell FinalCap what to edit', font=font(round(22*s),'SemiBold'), fill=MUTED)
    return img

def phone(canvas, screen, cx, top, screen_w):
    sw=screen_w; sh=round(screen.height*sw/screen.width); b=round(sw*0.034); R=round(sw*0.12)
    pw,ph=sw+2*b, sh+2*b; x0=round(cx-pw/2)
    shad=Image.new('L',(pw+40,ph+40),0); ImageDraw.Draw(shad).rounded_rectangle((20,28,20+pw,28+ph),R,fill=140)
    shad=shad.filter(ImageFilter.GaussianBlur(18))
    canvas.paste(Image.new('RGB', shad.size, (0,0,0)), (x0-20, top-20), shad)
    canvas.paste(Image.new('RGB',(pw,ph),(48,48,52)), (x0,top), rounded((pw,ph),R))
    inner=screen.resize((sw,sh), Image.LANCZOS)
    canvas.paste(inner, (x0+b, top+b), rounded((sw,sh), R-b))
    return top+ph

def build_frame(W,H,scale,idx,bbb):
    c=dark_bg(W,H); y=draw_caption(c, SHOTS[idx][1], SHOTS[idx][2], scale)
    top=y+round(48*scale); avail=H-top-round(90*scale)
    sw=min(int(avail/2.15), W-round(140*scale))
    screen=mock_screen(bbb, idx, 940, int(940*2.05))
    phone(c, screen, W/2, top, sw)
    return c.convert('RGB')

def main():
    frames=extract_frames(6)
    for prefix,(W,H) in SIZES.items():
        scale=W/1320
        for idx,(slug,*_) in enumerate(SHOTS):
            img=build_frame(W,H,scale,idx,frames[idx])
            assert img.size==(W,H) and img.mode=='RGB'
            dst=HERE/f'{prefix}-{slug}.png'
            img.save(dst, optimize=True)
            print(dst.name, img.size, SHOTS[idx][1].replace('\n',' / '))

if __name__=='__main__':
    main()
