#!/usr/bin/env python3
"""Runs inside the base sandbox. Downloads the media listed in ~/kit/assets.tsv into ~/redesign/.

Each line: <local path under assets/>\t<absolute http(s) URL>. The list was written by an agent reading
untrusted page content, so every line is validated: path must stay inside assets/, URL must be http(s),
files are capped in size and count.
"""
import os, sys, urllib.request, urllib.parse, posixpath


def original_url(url):
    """Image CDNs and resizers serve thumbnails; fetch the original instead.
    Next.js: /_next/image?url=<original>&w=96 -> <original>"""
    u = urllib.parse.urlparse(url)
    if u.path.endswith('/_next/image'):
        inner = urllib.parse.parse_qs(u.query).get('url', [''])[0]
        if inner:
            return urllib.parse.urljoin(url, inner)
    return url

HOME = os.path.expanduser('~')
ROOT = os.path.join(HOME, 'redesign')
MAX_FILES, MAX_FILE, MAX_TOTAL = 60, 15 * 2**20, 120 * 2**20
OK_EXT = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.mp4', '.webm', '.ico'}

def lines():
    # The extraction agent's list first, then everything the browser saw on the page (assets-auto.tsv).
    for name in ('assets.tsv', 'assets-auto.tsv'):
        path = os.path.join(HOME, 'kit', name)
        if os.path.exists(path):
            yield from open(path, encoding='utf-8', errors='replace')

total, n, ok, seen = 0, 0, [], set()
for line in lines():
    parts = line.rstrip('\n').split('\t')
    if len(parts) != 2:
        continue
    local, url = parts[0].strip(), parts[1].strip()
    norm = posixpath.normpath(local)
    if not norm.startswith('assets/') or '..' in norm.split('/') or posixpath.splitext(norm)[1].lower() not in OK_EXT:
        print('skip path', local); continue
    if url == 'local':
        # recorded on the page by qa.mjs (live canvases); already in place
        if os.path.exists(os.path.join(ROOT, norm)):
            ok.append(norm)
        continue
    if not url.startswith(('http://', 'https://')):
        print('skip url', url); continue
    url = original_url(url)
    key = urllib.parse.urlsplit(url)._replace(query='', fragment='').geturl()
    if key in seen:
        continue
    seen.add(key)
    if n >= MAX_FILES or total >= MAX_TOTAL:
        print('cap reached'); break
    dest = os.path.join(ROOT, norm)
    if os.path.exists(dest):
        ok.append(norm); continue
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Gondola/0.1'})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            print('too big', url); continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        open(dest, 'wb').write(data)
        total += len(data); n += 1; ok.append(norm)
    except Exception as e:
        print('fail', url, e)

def dims(path):
    """Pixel size from the file header (PNG, GIF, JPEG, WebP), no libraries needed."""
    try:
        with open(path, 'rb') as f:
            head = f.read(64)
            if head[:8] == b'\x89PNG\r\n\x1a\n':
                return int.from_bytes(head[16:20], 'big'), int.from_bytes(head[20:24], 'big')
            if head[:6] in (b'GIF87a', b'GIF89a'):
                return int.from_bytes(head[6:8], 'little'), int.from_bytes(head[8:10], 'little')
            if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
                if head[12:16] == b'VP8X':
                    return 1 + int.from_bytes(head[24:27], 'little'), 1 + int.from_bytes(head[27:30], 'little')
                if head[12:16] == b'VP8 ':
                    return int.from_bytes(head[26:28], 'little') & 0x3fff, int.from_bytes(head[28:30], 'little') & 0x3fff
                if head[12:16] == b'VP8L':
                    b = head[21:25]
                    return 1 + (((b[1] & 0x3f) << 8) | b[0]), 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6))
            if head[:2] == b'\xff\xd8':
                f.seek(2)
                while True:
                    marker = f.read(2)
                    if len(marker) < 2 or marker[0] != 0xff:
                        return None
                    if marker[1] in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
                        f.read(3)
                        h, w = int.from_bytes(f.read(2), 'big'), int.from_bytes(f.read(2), 'big')
                        return w, h
                    f.seek(int.from_bytes(f.read(2), 'big') - 2, 1)
    except Exception:
        return None
    return None

open(os.path.join(HOME, 'kit', 'assets-ok.txt'), 'w').write('\n'.join(ok) + '\n')
# media.tsv: path, width, height, bytes. The server turns it into media.md for the agents.
with open(os.path.join(HOME, 'kit', 'media.tsv'), 'w') as m:
    for p in ok:
        full = os.path.join(ROOT, p)
        wh = dims(full) if not p.endswith(('.svg', '.mp4', '.webm', '.ico')) else None
        m.write(f"{p}\t{wh[0] if wh else ''}\t{wh[1] if wh else ''}\t{os.path.getsize(full)}\n")
print(f'downloaded {n} files, {total // 1024} KiB; {len(ok)} usable')
