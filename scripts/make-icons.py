#!/usr/bin/env python3
"""Generate the app icons (equalizer bars on the remote's palette) with no third-party deps."""
import zlib, struct, sys
def png(path, n):
    S=4; N=n*S
    bg=(0x1a,0x1a,0x2e); acc=(0xe9,0x45,0x60); grn=(0x4e,0xcc,0xa3)
    # equalizer bars: heights as fraction
    bars=[0.30,0.55,0.85,0.60,0.40]
    px=[]
    for y in range(n):
        row=[]
        for x in range(n):
            acc_c=[0,0,0,0]
            for sy in range(S):
                for sx in range(S):
                    X=(x*S+sx+.5)/N; Y=(y*S+sy+.5)/N
                    # rounded square, radius .2
                    r=.2; dx=max(r-X,0,X-(1-r)); dy=max(r-Y,0,Y-(1-r))
                    if dx*dx+dy*dy>r*r: continue
                    c=bg
                    bw=.1; gap=.045; total=len(bars)*bw+(len(bars)-1)*gap; x0=(1-total)/2
                    for i,h in enumerate(bars):
                        bx=x0+i*(bw+gap)
                        top=.5-h*.38; bot=.5+h*.38
                        if bx<=X<=bx+bw and top<=Y<=bot:
                            t=(Y-top)/(bot-top)
                            c=tuple(int(grn[k]*(1-t)+acc[k]*t) for k in range(3))
                    acc_c[0]+=c[0];acc_c[1]+=c[1];acc_c[2]+=c[2];acc_c[3]+=255
            k=S*S
            a=acc_c[3]//k
            row+= [acc_c[0]//max(1,acc_c[3]//255), acc_c[1]//max(1,acc_c[3]//255), acc_c[2]//max(1,acc_c[3]//255), a] if a else [0,0,0,0]
        px.append(bytes([0]+row))
    raw=b''.join(px)
    def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    data=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',n,n,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw,9))+chunk(b'IEND',b'')
    open(path,'wb').write(data)
png(sys.argv[1]+'/icon.png',80); png(sys.argv[1]+'/largeIcon.png',130)
