#!/usr/bin/env python3
"""极简 PNG 解码 + 多点采样（仅支持 8-bit RGB/RGBA 非隔行，够用于截图）"""
import struct, sys, zlib

def load_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos, idat, w, h, ctype = 8, b'', 0, 0, None
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos+4])[0]
        typ = data[pos+4:pos+8]
        chunk = data[pos+8:pos+8+ln]
        if typ == b'IHDR':
            w, h, bd, ctype, comp, flt, inter = struct.unpack('>IIBBBBB', chunk)
            assert bd == 8 and inter == 0, f'不支持: bitdepth={bd} interlace={inter}'
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    ch = {2: 3, 6: 4}[ctype]
    stride = w * ch
    px = bytearray(w * h * ch)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p+stride]); p += stride
        if f == 1:   # Sub
            for i in range(ch, stride):
                line[i] = (line[i] + line[i-ch]) & 255
        elif f == 2: # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3: # Average
            for i in range(stride):
                a = line[i-ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4: # Paeth
            for i in range(stride):
                a = line[i-ch] if i >= ch else 0
                b = prev[i]
                c = prev[i-ch] if i >= ch else 0
                pa, pb, pc = abs(b-c), abs(a-c), abs(a+b-2*c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        px[y*stride:(y+1)*stride] = line
        prev = line
    return w, h, ch, px

def probe(img, name, fx, fy):
    w, h, ch, px = img
    x, y = int(w*fx), int(h*fy)
    rs = gs = bs = n = 0
    for dy in (-3, 0, 3):
        for dx in (-3, 0, 3):
            i = ((y+dy)*w + (x+dx)) * ch
            rs += px[i]; gs += px[i+1]; bs += px[i+2]; n += 1
    r, g, b = rs//n, gs//n, bs//n
    print(f'{name:14s} ({r:3d},{g:3d},{b:3d})  #{r:02x}{g:02x}{b:02x}')

if __name__ == '__main__':
    img = load_png(sys.argv[1])
    print('尺寸', img[0], 'x', img[1])
    probes = [
        ('左下角', 0.06, 0.88), ('右下角', 0.93, 0.88),
        ('左上', 0.06, 0.20), ('右上', 0.93, 0.20),
        ('顶部中间', 0.50, 0.19), ('底部中间', 0.50, 0.90),
        ('左中空隙', 0.24, 0.55), ('右中空隙', 0.75, 0.45),
        ('螺旋内空隙1', 0.44, 0.42), ('螺旋内空隙2', 0.55, 0.62),
        ('中心附近', 0.475, 0.60),
    ]
    for name, fx, fy in probes:
        probe(img, name, fx, fy)
