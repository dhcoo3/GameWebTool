export const LAYER_OPERATIONS = ['objects', 'ground', 'matte'];

export function layerGenerationPrompts(operation, width, height, custom = '') {
  const frame = `Canvas: retain the original ${width}x${height} full landscape frame and exact camera/framing. DO NOT crop to content, zoom, reposition, rotate, rescale the spatial layout or make an asset sheet. Output ONE image, not a comparison. Match the original art style, colors, pixel texture, perspective and lighting.`;
  const objects = `Use case: background-extraction. Asset: transparent foreground object layer for this exact 2D isometric game map.
Extract EVERY standing object into ONE full-canvas transparent PNG layer, preserving each object's original location, size, shape, pixel colors, perspective and occlusion. Retain all houses/buildings including cropped edge buildings and foundations, trees with trunks and fine foliage, shrubs, fences, stone fence pillars, torches/flames, barrels, crates, loose large decorative rocks and standalone props. Remove ALL flat terrain: dirt, roads, cobblestone plaza, scattered flat paving stones, flat grass/moss patches. All gaps between objects, open streets, exterior areas, fence posts and foliage must be TRUE alpha transparency. No opaque black/white/checkerboard background, ground islands, backdrop or cast shadows glued to large terrain patches. Do not invent, replace or rearrange objects. Clean alpha edges without black halos. This layer must overlay the original ground at the same coordinates.
${frame}`;
  const ground = `Use case: precise-object-edit / clean background plate. Asset: ground-only layer for this exact game map.
Remove EVERY standing object: houses/buildings including cropped edge buildings, roofs, walls, foundations/raised bases, trees/trunks, bushes/shrubs, fences/posts, pillars, torches/flames, crates, barrels, large decorative boulders and elevated props. No remnants, silhouettes, roof-shaped patches, stumps or ghost shadows.
KEEP flat terrain in its exact original positions: cobblestone plazas, dirt roads, scattered flat paving stones, moss/grass patches and fine ground texture. Reconstruct removed footprints with continuous dirt, irregular paving or grass matching the immediate surroundings. Flat vegetation stays; raised bushes go. Retain diffuse ground lighting without light-emitting props. Do not regenerate the settlement or add any buildings or objects. Fully opaque rectangular terrain covering every edge; no transparency, black void, border or text. Ground layer ONLY, intended directly beneath a transparent object layer at identical coordinates.
Preserve the original density, scale and sharp edges of individual paving stones, pebbles, cracks, soil grains, grass blades and moss. Keep local contrast, exposure and color variation; do not smooth, blur, simplify textures, apply a dark veil, dim the whole image or replace detailed terrain with broad flat patches. Reconstruct hidden ground with the same fine texture density as the visible surrounding ground. Any outer framing padding is outside the map content.
${frame}`;
  const matte = `Generate ONLY a binary foreground-object segmentation mask for the supplied image. This is a pixel-aligned classification task, not an illustration or a redraw.

OUTPUT
One image, exactly ${width}×${height} pixels.
Use only pure white (#FFFFFF) and pure black (#000000).
No gray, color, transparency, gradients, feathering, outlines, labels or comparison panels.

WHITE — COMPLETE FOREGROUND OBJECTS
Mark the entire visible silhouette of every standing or raised object:
• Buildings, including roofs, walls, foundations, chimneys, eaves and attached structural parts.
• Buildings and other objects cut off by the image edges.
• Trees, including complete foliage masses, trunks and branches.
• Shrubs, fences, posts, pillars, torches and flames.
• Crates, barrels and large raised rocks.

Treat each visible object as a solid filled shape. Include its dark sides, shaded surfaces, cracks, material patterns and internal details in white. These are parts of the object, not holes.

Preserve narrow connecting parts such as fence rails, branches, posts and supports. Do not reduce objects to disconnected fragments or edge outlines.

BLACK — GROUND AND GENUINE OPEN SPACE
Mark flat terrain black: dirt, roads, cobblestone plazas, flat paving, flat grass and moss.
Exclude cast shadows and lighting effects on the ground.

Leave a gap black ONLY where the original image visibly shows ground or background through a real opening, such as between separate fence rails or separate branches. Dark coloration alone does not indicate an opening. Do not invent holes inside roofs, walls, rocks or foliage masses.

ALIGNMENT
Keep the exact original full-frame composition and object boundaries.
Do not move, resize, rotate, straighten, simplify or reconstruct objects.
Do not crop, zoom, add margins, create an asset sheet or complete hidden surfaces.
Where objects overlap, mark the union of their visible silhouettes white.

FINAL CHECK
All visible object surfaces are solid white, including dark surfaces.
All flat ground is black.
No object is represented only by its outline.
No textures, highlights or shadows appear inside the white shapes.
Return only the mask image.`;
  return { prompt: (typeof custom === 'string' ? custom.trim() : '') || ({ objects, ground, matte })[operation] || '', negativePrompt: '' };
}
