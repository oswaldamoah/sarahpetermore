"""Builds the fast, shop-ready product images from web/public/img/products/*.{webp,jpg}:
   sm/<name>.webp  400px  (cards)      md/<name>.webp  800px  (product page)
Photos on a plain white background get that background removed (transparent), so the product
sits on the site's soft colour tiles. Photos with their own coloured background are kept as they are.
Usage: python3 scripts/make_thumbs.py [web/public/img/products]"""
import glob, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

root = sys.argv[1] if len(sys.argv) > 1 else 'web/public/img/products'
os.makedirs(f'{root}/sm', exist_ok=True); os.makedirs(f'{root}/md', exist_ok=True)

def cutout(im: Image.Image) -> Image.Image:
    rgb = im.convert('RGB'); w, h = rgb.size
    a = np.asarray(rgb).astype(np.int16)
    near = (a.min(axis=2) >= 236) & ((a.max(axis=2) - a.min(axis=2)) <= 18)
    edge = np.concatenate([near[0], near[-1], near[:, 0], near[:, -1]])
    if edge.mean() < 0.6:
        return rgb  # has its own background: keep it, the card shows it edge to edge
    m = Image.fromarray((near * 255).astype(np.uint8), 'L').copy()  # copy: arrays give read-only images
    for x, y in [(x, 0) for x in range(0, w, 4)] + [(x, h - 1) for x in range(0, w, 4)] + [(0, y) for y in range(0, h, 4)] + [(w - 1, y) for y in range(0, h, 4)]:
        if m.getpixel((x, y)) == 255: ImageDraw.floodfill(m, (x, y), 128)
    alpha = m.point(lambda v: 0 if v == 128 else 255).filter(ImageFilter.GaussianBlur(1.2))
    out = rgb.copy(); out.putalpha(alpha)
    box = out.getbbox() or (0, 0, w, h)
    out = out.crop(box)
    # centre the product in a square with breathing room, so the card can simply fill its tile
    side = int(max(out.size) / 0.8)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(out, ((side - out.width) // 2, (side - out.height) // 2))
    return canvas

n = cut = 0
for f in sorted(glob.glob(f'{root}/*.webp') + glob.glob(f'{root}/*.jpg')):
    base = os.path.splitext(os.path.basename(f))[0]
    im = Image.open(f); im.thumbnail((800, 800), Image.LANCZOS)
    c = cutout(im); cut += c.mode == 'RGBA'
    c.thumbnail((800, 800), Image.LANCZOS)
    c.save(f'{root}/md/{base}.webp', 'WEBP', quality=80, method=6)
    s = c.copy(); s.thumbnail((400, 400), Image.LANCZOS)
    s.save(f'{root}/sm/{base}.webp', 'WEBP', quality=76, method=6)
    n += 1
print(f'{n} images, {cut} background-removed')
