"""Draw mint's app icon and build the platform icon files.

The mark is mint's four-dot grid on a pale aluminium tile, in the
Teenage Engineering spirit of the UI: ink dots, one muted sage dot.

    python3 -I scripts/make-icon.py build

Writes build/icon.png (1024 px), build/icon.icns (macOS, via iconutil)
and build/icon.ico (Windows).
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SS = 4  # supersampling for smooth edges
SIZE = 1024


def tile(size: int) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # macOS icon grid: an 824 px body centred in 1024, corner radius ~185 px.
    inset = round(s * 100 / 1024)
    radius = round(s * 185 / 1024)
    body = (inset, inset, s - inset, s - inset)

    # Soft drop shadow under the tile.
    shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((body[0], body[1] + 18 * SS, body[2], body[3] + 18 * SS), radius, fill=(0, 0, 0, 70))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(22 * SS)))

    # Aluminium face: a gentle vertical gradient, clipped to the rounded square.
    face = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    grad = ImageDraw.Draw(face)
    top, bottom = (246, 246, 243), (226, 226, 222)
    for y in range(body[1], body[3]):
        t = (y - body[1]) / (body[3] - body[1])
        grad.line([(body[0], y), (body[2], y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle(body, radius, fill=255)
    img.paste(face, (0, 0), mask)

    # Hairline bevel: a light top edge and a darker outline.
    edge = ImageDraw.Draw(img)
    edge.rounded_rectangle(body, radius, outline=(196, 196, 191, 255), width=3 * SS)
    edge.rounded_rectangle((body[0] + 3 * SS, body[1] + 3 * SS, body[2] - 3 * SS, body[3] - 3 * SS), radius - 3 * SS, outline=(255, 255, 255, 150), width=2 * SS)

    # The mark: a 2 x 2 grid of dots.
    d = round(s * 150 / 1024)  # dot diameter
    gap = round(s * 74 / 1024)
    span = 2 * d + gap
    x0 = (s - span) // 2
    y0 = (s - span) // 2
    ink, sage = (22, 22, 22, 255), (143, 181, 159, 255)
    dots = ImageDraw.Draw(img)
    for row in range(2):
        for col in range(2):
            x = x0 + col * (d + gap)
            y = y0 + row * (d + gap)
            dots.ellipse((x, y, x + d, y + d), fill=sage if (row, col) == (1, 1) else ink)

    return img.resize((size, size), Image.LANCZOS)


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    master = tile(SIZE)
    master.save(out / "icon.png")
    master.save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    iconutil = shutil.which("iconutil")
    if not iconutil:
        print("iconutil not found (macOS only): skipped icon.icns")
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for base in (16, 32, 128, 256, 512):
            master.resize((base, base), Image.LANCZOS).save(iconset / f"icon_{base}x{base}.png")
            master.resize((base * 2, base * 2), Image.LANCZOS).save(iconset / f"icon_{base}x{base}@2x.png")
        subprocess.run([iconutil, "-c", "icns", str(iconset), "-o", str(out / "icon.icns")], check=True)
    print(f"wrote {out}/icon.png, icon.ico, icon.icns")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "build")
