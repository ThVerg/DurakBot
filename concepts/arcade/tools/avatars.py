import sys
from collections import deque
import numpy as np
from PIL import Image, ImageFilter
SRC='/home/theofanis/DurakBot/concepts/assets/avatars/'
DST='/home/theofanis/DurakBot/concepts/arcade/img/'
# bright arcade backgrounds: (top colour, bottom colour)
BG={'kostya':((120,214,255),(40,140,255)),
    'zina':((255,214,110),(255,150,60)),
    'misha':((150,236,120),(52,186,96)),
    'sveta':((255,150,205),(214,84,190)),
    'you':((120,170,255),(70,96,240)),
    'lev':((150,236,230),(40,180,190)),
    'dasha':((255,190,140),(250,110,110)),
    'grisha':((190,170,255),(120,90,240))}
HUECLEAN={'kostya','you','lev'}
GROW={'sveta':5,'you':5,'kostya':5,'zina':3,'misha':3,'lev':5}
def run(name, tol=7.0):
    im=Image.open(SRC+name+'.webp').convert('RGB'); a=np.asarray(im).astype(np.int32)
    H,W,_=a.shape; mask=np.zeros((H,W),bool); q=deque()
    for x in range(W): q.append((0,x))
    for y in range(H//2): q.append((y,0)); q.append((y,W-1))
    for y,x in q: mask[y,x]=True
    while q:
        y,x=q.popleft()
        for dy,dx in ((1,0),(-1,0),(0,1),(0,-1)):
            ny,nx=y+dy,x+dx
            if 0<=ny<H and 0<=nx<W and not mask[ny,nx]:
                if np.abs(a[ny,nx]-a[y,x]).sum()<=tol:
                    mask[ny,nx]=True; q.append((ny,nx))
    if name in HUECLEAN:
        import colorsys
        hsv=np.asarray(im.convert('HSV')).astype(np.int32)
        bgh=np.median(hsv[...,0][mask]); 
        cand=(np.abs(hsv[...,0]-bgh)<10)&(hsv[...,1]>60); cand[int(H*0.55):,:]=False
        # grow mask into connected candidate pixels
        q=deque(zip(*np.nonzero(mask)))
        while q:
            y,x=q.popleft()
            for dy,dx in ((1,0),(-1,0),(0,1),(0,-1)):
                ny,nx=y+dy,x+dx
                if 0<=ny<H and 0<=nx<W and not mask[ny,nx] and cand[ny,nx]:
                    mask[ny,nx]=True; q.append((ny,nx))
    m=Image.fromarray((mask*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(GROW.get(name,3))).filter(ImageFilter.GaussianBlur(0.9))
    t,b=BG[name]; g=np.zeros((H,W,3)); yy=np.linspace(0,1,H)[:,None]
    # vertical gradient + soft radial glow behind the head
    for c in range(3): g[:,:,c]=t[c]*(1-yy)+b[c]*yy
    Y,X=np.mgrid[0:H,0:W]; r=np.sqrt((X-W/2)**2+(Y-H*0.42)**2)/(W*0.55)
    glow=np.clip(1-r,0,1)**1.5*0.35; g=g+(255-g)*glow[:,:,None]
    bg=Image.fromarray(np.clip(g,0,255).astype(np.uint8))
    out=Image.composite(bg,im,m)
    out.save(DST+name+'.webp',quality=92)
    return mask.mean()
for n in sys.argv[1:]:
    print(n, round(run(n),3))
