#!/usr/bin/env python3
"""
Turn an opaque radar-frame artwork into the RGBA overlay the app needs.

    python3 tools/make-frame-transparent.py assets/frame-source.png assets/frame.png

What it does:
  * flood-fills the white *outside* the device (from the four corners) and the
    white *inside* the window (from the centre) to alpha 0, leaving the body
    opaque. Flood-filling rather than keying on colour means white pixels that
    are part of the artwork itself survive.
  * feathers the resulting edge by one pixel so it doesn't read as jagged.
  * measures the window circle and prints the CSS values for style.css.

Stdlib only - no Pillow required.
"""
import struct, sys, zlib
from collections import deque

WHITE = 246          # channel value at or above which a pixel counts as "white"
NEAR_WHITE = 232     # used only for the 1px feather

def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
    pos, idat, meta = 8, bytearray(), None
    while pos < len(data):
        (length,) = struct.unpack('>I', data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if tag == b'IHDR':
            meta = struct.unpack('>IIBBBBB', body)
        elif tag == b'IDAT':
            idat += body
        elif tag == b'IEND':
            break
        pos += 12 + length

    w, h, depth, ctype, comp, filt, inter = meta
    assert depth == 8 and inter == 0, 'need 8-bit non-interlaced'
    assert ctype in (2, 6), 'need RGB or RGBA'
    nch = 3 if ctype == 2 else 4

    raw = zlib.decompress(bytes(idat))
    stride = w * nch
    out = bytearray(w * h * nch)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if ft == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 0xff
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xff
        elif ft == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff
        elif ft == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                c = prev[i - nch] if i >= nch else 0
                b = prev[i]
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xff
        elif ft != 0:
            raise ValueError(f'bad filter {ft}')
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, nch, out

def write_png(path, w, h, rgba):
    rows = bytearray()
    stride = w * 4
    for y in range(h):
        rows += b'\x00' + rgba[y * stride:(y + 1) * stride]
    def chunk(tag, body):
        return (struct.pack('>I', len(body)) + tag + body
                + struct.pack('>I', zlib.crc32(tag + body) & 0xffffffff))
    open(path, 'wb').write(
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(bytes(rows), 9))
        + chunk(b'IEND', b''))

def main(src, dst):
    w, h, nch, px = read_png(src)

    def white(i):
        o = i * nch
        return px[o] >= WHITE and px[o + 1] >= WHITE and px[o + 2] >= WHITE

    def flood(seeds, mark):
        """4-connected fill over white-ish pixels. Returns pixels filled."""
        q = deque()
        for s in seeds:
            if white(s) and not mark[s]:
                mark[s] = True
                q.append(s)
        filled = 0
        while q:
            i = q.popleft(); filled += 1
            x, y = i % w, i // w
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if not mark[j] and white(j):
                        mark[j] = True
                        q.append(j)
        return filled

    # --- outside: seed from every border pixel (the knob touches the top edge,
    # so corners alone can miss a region).
    outside = bytearray(w * h)
    border = ([y * w for y in range(h)] + [y * w + w - 1 for y in range(h)]
              + list(range(w)) + [(h - 1) * w + x for x in range(w)])
    n_out = flood(border, outside)

    # --- window: seed from the middle of the image, which sits inside the glass.
    window = bytearray(w * h)
    n_win = flood([(h // 2) * w + w // 2], window)
    if n_win == 0:
        sys.exit('Could not find a white window at the centre of the image.')

    clear = bytearray(a | b for a, b in zip(outside, window))

    # --- build RGBA, feathering pixels that touch a cleared region.
    rgba = bytearray(w * h * 4)
    for i in range(w * h):
        o, q = i * nch, i * 4
        rgba[q:q + 3] = px[o:o + 3]
        if clear[i]:
            rgba[q + 3] = 0
            continue
        alpha = 255
        x, y = i % w, i // w
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and clear[ny * w + nx]:
                if min(px[o], px[o + 1], px[o + 2]) >= NEAR_WHITE:
                    alpha = 96      # light fringe pixel: mostly background
                else:
                    alpha = 190     # coloured edge: keep most of it
                break
        rgba[q + 3] = alpha

    # --- crop away fully transparent margins. Artwork often ships with a lot
    # of empty space, and on a portrait phone every wasted pixel of width
    # shrinks the radar.
    ox = [i % w for i in range(w * h) if rgba[i * 4 + 3] > 8]
    oy = [i // w for i in range(w * h) if rgba[i * 4 + 3] > 8]
    cx0, cx1, cy0, cy1 = min(ox), max(ox), min(oy), max(oy)
    cw, ch = cx1 - cx0 + 1, cy1 - cy0 + 1

    cropped = bytearray(cw * ch * 4)
    for y in range(ch):
        src = ((y + cy0) * w + cx0) * 4
        cropped[y * cw * 4:(y + 1) * cw * 4] = rgba[src:src + cw * 4]

    write_png(dst, cw, ch, cropped)

    # --- measure the window circle so the canvas can be placed on it,
    # in coordinates relative to the cropped image.
    xs = [i % w for i in range(w * h) if window[i]]
    ys = [i // w for i in range(w * h) if window[i]]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    cx, cy = (x0 + x1 + 1) / 2 - cx0, (y0 + y1 + 1) / 2 - cy0
    dia = ((x1 - x0 + 1) + (y1 - y0 + 1)) / 2

    print(f'{dst}: {w}x{h} -> cropped {cw}x{ch} RGBA  '
          f'(cleared {n_out} px outside, {n_win} px window)')
    print(f'window circle: {x1-x0+1}x{y1-y0+1} px, '
          f'centre {cx:.1f},{cy:.1f} within the crop')
    print('\n--- paste into style.css :root ---')
    print(f'  --frame-aspect: {cw} / {ch};')
    print(f'  --scope-size: {100 * dia / cw:.3f}%;')
    print(f'  --scope-left: {100 * (cx - dia / 2) / cw:.3f}%;')
    print(f'  --scope-top:  {100 * (cy - dia / 2) / ch:.3f}%;')
    print('\nNote --scope-size is a % of WIDTH for both axes, so the scope '
          'stays circular.')

if __name__ == '__main__':
    main(*(sys.argv[1:3] or ['assets/frame-source.png', 'assets/frame.png']))
