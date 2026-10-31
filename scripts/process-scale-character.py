"""Local chroma-key processing only; never sends a generation request."""
from collections import deque
from pathlib import Path
import json
from PIL import Image, ImageOps

directory = Path(__file__).resolve().parent.parent / 'public/assets/scale-reference'
record = json.loads((directory / 'generation.json').read_text())
image = Image.open(directory / record['originalFile']).convert('RGBA')
width, height = image.size
pixels = image.load()
seen = bytearray(width * height)
queue = deque()

def is_background(x, y):
    r, g, b, a = pixels[x, y]
    return a == 0 or (g > max(r, b) + 18 and g > r * 1.15 and g > b * 1.15)

def visit(x, y):
    index = y * width + x
    if not seen[index] and is_background(x, y):
        seen[index] = 1
        queue.append((x, y))

for x in range(width): visit(x, 0); visit(x, height - 1)
for y in range(height): visit(0, y); visit(width - 1, y)
while queue:
    x, y = queue.popleft()
    pixels[x, y] = (0, 0, 0, 0)
    if x: visit(x - 1, y)
    if x + 1 < width: visit(x + 1, y)
    if y: visit(x, y - 1)
    if y + 1 < height: visit(x, y + 1)

# Mirror the generated left-facing pose into the requested southeast pose.
image = ImageOps.mirror(image)
bounds = image.getchannel('A').getbbox()
if not bounds or sum(seen) < width * height * .2:
    raise RuntimeError('去底结果不合格，请检查原图，勿自动再次调用可灵。')
image.save(directory / 'character-cutout.png')
subject = image.crop(bounds)
subject = subject.resize((max(1, round(subject.width * 96 / subject.height)), 96), Image.Resampling.NEAREST)
output = Image.new('RGBA', (subject.width + 4, 100))
output.paste(subject, (2, 2))
output.save(directory / 'character.png')
x0, y0, x1, y1 = output.getchannel('A').getbbox()
preset = {
    'version': 1, 'name': '暗红兜帽冒险者 · 可灵临时比例方案', 'characterFile': 'character.png',
    'provider': 'kling', 'model': record['model'], 'resolution': '1K', 'generatedAt': record['generatedAt'],
    'scaleReference': {
        'enabled': True, 'visible': True, 'heightPx': 96, 'footWidthPx': 32, 'footDepthPx': 16,
        'feetX': .5, 'feetY': 1, 'speedPx': 160, 'doorHeightPx': 120, 'doorWidthPx': 64,
        'roadWidthPx': 96, 'houseWidthCells': 4, 'houseDepthCells': 3, 'treeMinHeightPx': 192, 'treeMaxHeightPx': 384,
        'bounds': {'x': x0, 'y': y0, 'width': x1-x0, 'height': y1-y0, 'sourceWidth': output.width, 'sourceHeight': output.height},
    },
}
(directory / 'preset.json').write_text(json.dumps(preset, ensure_ascii=False, indent=2))
print(json.dumps({'source': [width, height], 'removedPixels': sum(seen), 'bounds': preset['scaleReference']['bounds'], 'saved': str(directory / 'character.png')}, ensure_ascii=False))
