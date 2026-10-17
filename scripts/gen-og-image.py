#!/usr/bin/env python3
"""Generate a 1200x630 OG image for Satvis (satvis.space).

Brand palette from public/logo.svg:
  navy bg #0b222d, blue #4082a0, orange #e95a26, cream #fff3e0
Motif: dark space gradient, a stylized satellite with solar panels, orbit arcs,
star field, "Satvis" wordmark + tagline.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math, random

W, H = 1200, 630
NAVY = (11, 34, 45)
NAVY2 = (4, 25, 30)
BLUE = (64, 130, 160)
ORANGE = (233, 90, 38)
CREAM = (255, 243, 224)
WHITE = (255, 255, 255)

FONT_SEMI = "/home/paperclip/.fonts/Montserrat-SemiBold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

img = Image.new("RGB", (W, H), NAVY)
d = ImageDraw.Draw(img)

# vertical gradient navy -> darker
for y in range(H):
    t = y / H
    r = int(NAVY[0] + (NAVY2[0] - NAVY[0]) * t)
    g = int(NAVY[1] + (NAVY2[1] - NAVY[1]) * t)
    b = int(NAVY[2] + (NAVY2[2] - NAVY[2]) * t)
    d.line([(0, y), (W, y)], fill=(r, g, b))

# star field
rng = random.Random(42)
for _ in range(160):
    x = rng.randint(0, W - 1)
    y = rng.randint(0, H - 1)
    rad = rng.choice([1, 1, 1, 2])
    alpha = rng.randint(60, 200)
    d.ellipse([x, y, x + rad, y + rad], fill=(alpha, alpha, alpha + 20))

# orbit arcs (subtle)
for i, (cx, cy, rx, ry) in enumerate([(600, 300, 430, 150), (600, 300, 520, 200)]):
    pts = []
    for a in range(0, 360, 3):
        rad = math.radians(a)
        pts.append((cx + rx * math.cos(rad), cy + ry * math.sin(rad) * 0.6))
    d.line(pts, fill=(BLUE[0], BLUE[1], BLUE[2], 90), width=2)

# --- satellite (stylized, centered-right) ---
sx, sy = 760, 300
# solar panels (two wings)
d.rectangle([sx - 150, sy - 26, sx - 30, sy + 26], fill=(40, 60, 70), outline=BLUE, width=3)
d.rectangle([sx + 30, sy - 26, sx + 150, sy + 26], fill=(40, 60, 70), outline=BLUE, width=3)
# panel grid lines
for gx in range(sx - 150, sx - 30, 24):
    d.line([(gx, sy - 26), (gx, sy + 26)], fill=(64, 130, 160, 120), width=1)
for gx in range(sx + 30, sx + 150, 24):
    d.line([(gx, sy - 26), (gx, sy + 26)], fill=(64, 130, 160, 120), width=1)
# body
d.rounded_rectangle([sx - 30, sy - 40, sx + 30, sy + 40], radius=8, fill=(20, 40, 50), outline=ORANGE, width=3)
# antenna dish
d.ellipse([sx - 12, sy - 60, sx + 12, sy - 36], outline=CREAM, width=3)
d.line([(sx, sy - 36), (sx, sy - 20)], fill=CREAM, width=3)
# body detail
d.rectangle([sx - 18, sy - 8, sx + 18, sy + 8], fill=BLUE)

# --- text ---
# wordmark
f_title = ImageFont.truetype(FONT_SEMI, 96)
f_tag = ImageFont.truetype(FONT_REG, 34)
f_pill = ImageFont.truetype(FONT_SEMI, 26)

d.text((90, 120), "Satvis", font=f_title, fill=WHITE)
# tagline
d.text((92, 250), "3D satellite tracker & sky view", font=f_tag, fill=CREAM)
# pill
pill_text = "16,000+ satellites live on a 3D globe"
tw = d.textlength(pill_text, font=f_pill)
d.rounded_rectangle([90, 320, 90 + tw + 40, 320 + 52], radius=26, fill=ORANGE)
d.text((110, 332), pill_text, font=f_pill, fill=WHITE)

# small footer
f_foot = ImageFont.truetype(FONT_REG, 24)
d.text((90, 540), "satvis.space", font=f_foot, fill=(150, 190, 205))

img.save("/home/paperclip/satvis-work/public/og-image.png", "PNG")
print("saved public/og-image.png", img.size)
