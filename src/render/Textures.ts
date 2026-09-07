/**
 * Procedural texture generation on 2D canvases. No external assets are required, which keeps
 * the download tiny and lets every quality preset pick its own resolution.
 */
import {
  CanvasTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  NoColorSpace,
} from 'three';
import { Random, valueNoise2D } from '../world/Random';

export interface FacadeMaps {
  map: Texture;
  emissiveMap: Texture;
  roughnessMap: Texture;
  /** Windows per tile horizontally / floors per tile vertically. */
  windowsPerTile: number;
  floorsPerTile: number;
  /** Real-world size of one tile (metres). */
  tileWidth: number;
  tileHeight: number;
}

export interface FacadeStyle {
  wall: [number, number, number];
  window: [number, number, number];
  windowLit: [number, number, number];
  windowsPerTile: number;
  floorsPerTile: number;
  windowW: number; // 0..1 fraction of cell
  windowH: number;
  litChance: number;
  /** Horizontal bands (ledges) every N floors, 0 = none. */
  bandEvery: number;
  tileWidth: number;
  tileHeight: number;
}

export const FACADE_STYLES: FacadeStyle[] = [
  // 0: glass tower (blue-grey glass, tall dark mullions)
  { wall: [58, 66, 78], window: [96, 130, 170], windowLit: [255, 230, 170], windowsPerTile: 6, floorsPerTile: 6, windowW: 0.86, windowH: 0.8, litChance: 0.35, bandEvery: 0, tileWidth: 12, tileHeight: 21 },
  // 1: modern office (light concrete, wide windows)
  { wall: [176, 172, 165], window: [70, 88, 105], windowLit: [255, 220, 150], windowsPerTile: 5, floorsPerTile: 5, windowW: 0.7, windowH: 0.55, litChance: 0.3, bandEvery: 1, tileWidth: 12, tileHeight: 17.5 },
  // 2: brick residential
  { wall: [140, 78, 62], window: [40, 44, 52], windowLit: [255, 210, 140], windowsPerTile: 4, floorsPerTile: 4, windowW: 0.45, windowH: 0.6, litChance: 0.4, bandEvery: 0, tileWidth: 10, tileHeight: 13 },
  // 3: plaster apartments (warm beige)
  { wall: [206, 190, 160], window: [45, 50, 60], windowLit: [255, 225, 160], windowsPerTile: 4, floorsPerTile: 4, windowW: 0.5, windowH: 0.62, litChance: 0.45, bandEvery: 2, tileWidth: 10, tileHeight: 12.5 },
  // 4: industrial (corrugated grey, few windows)
  { wall: [122, 126, 128], window: [60, 66, 70], windowLit: [220, 235, 255], windowsPerTile: 3, floorsPerTile: 2, windowW: 0.6, windowH: 0.35, litChance: 0.25, bandEvery: 0, tileWidth: 12, tileHeight: 8 },
  // 5: warehouse (dark red metal)
  { wall: [96, 52, 46], window: [50, 54, 58], windowLit: [230, 240, 255], windowsPerTile: 2, floorsPerTile: 2, windowW: 0.5, windowH: 0.3, litChance: 0.2, bandEvery: 0, tileWidth: 12, tileHeight: 8 },
];

function createCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

function rgb(c: [number, number, number], mul = 1): string {
  return `rgb(${Math.round(c[0] * mul)},${Math.round(c[1] * mul)},${Math.round(c[2] * mul)})`;
}

function finish(canvas: HTMLCanvasElement, opts: { srgb: boolean; anisotropy: number; nearest?: boolean }): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = opts.srgb ? SRGBColorSpace : NoColorSpace;
  tex.anisotropy = opts.anisotropy;
  tex.magFilter = opts.nearest ? NearestFilter : LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Fill a canvas with per-pixel value noise (fast, uses ImageData). */
function noiseFill(ctx: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], amount: number, rng: Random): void {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const n = (rng.next() - 0.5) * 2 * amount;
    d[i * 4] = clamp255(base[0] + n);
    d[i * 4 + 1] = clamp255(base[1] + n);
    d[i * 4 + 2] = clamp255(base[2] + n);
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

export function createFacadeMaps(styleIndex: number, size: number, anisotropy: number, seed = 1): FacadeMaps {
  const style = FACADE_STYLES[styleIndex % FACADE_STYLES.length]!;
  const rng = new Random(seed * 131 + styleIndex);
  const { canvas: albedo, ctx: a } = createCanvas(size, size);
  const { canvas: emissive, ctx: e } = createCanvas(size, size);
  const { canvas: rough, ctx: r } = createCanvas(size, size);

  noiseFill(a, size, size, style.wall, 10, rng);
  e.fillStyle = '#000';
  e.fillRect(0, 0, size, size);
  r.fillStyle = 'rgb(210,210,210)'; // walls rough
  r.fillRect(0, 0, size, size);

  const cellW = size / style.windowsPerTile;
  const cellH = size / style.floorsPerTile;
  for (let fy = 0; fy < style.floorsPerTile; fy++) {
    if (style.bandEvery > 0 && fy % style.bandEvery === 0) {
      a.fillStyle = rgb(style.wall, 0.82);
      a.fillRect(0, fy * cellH, size, Math.max(2, cellH * 0.06));
    }
    for (let fx = 0; fx < style.windowsPerTile; fx++) {
      const ww = cellW * style.windowW;
      const wh = cellH * style.windowH;
      const x = fx * cellW + (cellW - ww) / 2;
      const y = fy * cellH + (cellH - wh) / 2;
      const shade = 0.85 + rng.next() * 0.3;
      a.fillStyle = rgb(style.window, shade);
      a.fillRect(x, y, ww, wh);
      // frame
      a.strokeStyle = rgb(style.wall, 0.6);
      a.lineWidth = Math.max(1, size / 256);
      a.strokeRect(x, y, ww, wh);
      // glossy windows
      r.fillStyle = 'rgb(60,60,60)';
      r.fillRect(x, y, ww, wh);
      if (rng.chance(style.litChance)) {
        const lit = 0.6 + rng.next() * 0.4;
        e.fillStyle = rgb(style.windowLit, lit);
        e.fillRect(x + 1, y + 1, ww - 2, wh - 2);
      }
    }
  }
  return {
    map: finish(albedo, { srgb: true, anisotropy }),
    emissiveMap: finish(emissive, { srgb: true, anisotropy }),
    roughnessMap: finish(rough, { srgb: false, anisotropy }),
    windowsPerTile: style.windowsPerTile,
    floorsPerTile: style.floorsPerTile,
    tileWidth: style.tileWidth,
    tileHeight: style.tileHeight,
  };
}

export interface RoadMaps {
  map: Texture;
  normalMap: Texture;
  roughnessMap: Texture;
}

/**
 * Road strip texture: u spans the full road width (edge line, lanes, dashed centre line),
 * v repeats along the road every `metresPerRepeat`.
 */
export function createRoadMaps(size: number, anisotropy: number, lanesPerDirection: number, seed = 2): RoadMaps {
  const rng = new Random(seed);
  const { canvas: albedo, ctx: a } = createCanvas(size, size);
  const { canvas: rough, ctx: r } = createCanvas(size, size);
  noiseFill(a, size, size, [52, 52, 54], 14, rng);
  r.fillStyle = 'rgb(235,235,235)';
  r.fillRect(0, 0, size, size);

  const lanes = lanesPerDirection * 2;
  const laneW = size / lanes;
  const lineW = Math.max(2, size * 0.012);
  // dashed centre line (double yellow when 2+ lanes per direction)
  a.fillStyle = 'rgb(210,180,60)';
  const cx = size / 2;
  a.fillRect(cx - lineW * 1.6, 0, lineW, size);
  a.fillRect(cx + lineW * 0.6, 0, lineW, size);
  r.fillStyle = 'rgb(140,140,140)';
  r.fillRect(cx - lineW * 1.6, 0, lineW, size);
  r.fillRect(cx + lineW * 0.6, 0, lineW, size);
  // lane dashes (white) between same-direction lanes
  a.fillStyle = 'rgb(220,220,220)';
  for (let l = 1; l < lanes; l++) {
    if (l === lanesPerDirection) continue;
    const x = l * laneW - lineW / 2;
    for (let y = 0; y < size; y += size / 4) {
      a.fillRect(x, y, lineW, size / 8);
      r.fillRect(x, y, lineW, size / 8);
    }
  }
  // edge lines
  a.fillRect(size * 0.02, 0, lineW, size);
  a.fillRect(size - size * 0.02 - lineW, 0, lineW, size);
  r.fillRect(size * 0.02, 0, lineW, size);
  r.fillRect(size - size * 0.02 - lineW, 0, lineW, size);

  const normal = createNormalMapFromNoise(size, 1.6, rng);
  return {
    map: finish(albedo, { srgb: true, anisotropy }),
    normalMap: finish(normal, { srgb: false, anisotropy }),
    roughnessMap: finish(rough, { srgb: false, anisotropy }),
  };
}

export function createAsphaltMaps(size: number, anisotropy: number, seed = 3): RoadMaps {
  const rng = new Random(seed);
  const { canvas: albedo, ctx: a } = createCanvas(size, size);
  const { canvas: rough, ctx: r } = createCanvas(size, size);
  noiseFill(a, size, size, [52, 52, 54], 14, rng);
  r.fillStyle = 'rgb(235,235,235)';
  r.fillRect(0, 0, size, size);
  const normal = createNormalMapFromNoise(size, 1.6, rng);
  return {
    map: finish(albedo, { srgb: true, anisotropy }),
    normalMap: finish(normal, { srgb: false, anisotropy }),
    roughnessMap: finish(rough, { srgb: false, anisotropy }),
  };
}

export function createConcreteMap(size: number, anisotropy: number, seed = 4): { map: Texture; normalMap: Texture } {
  const rng = new Random(seed);
  const { canvas, ctx } = createCanvas(size, size);
  noiseFill(ctx, size, size, [150, 148, 142], 9, rng);
  // paving joints
  ctx.strokeStyle = 'rgb(110,108,104)';
  ctx.lineWidth = Math.max(1, size / 256);
  const cells = 4;
  for (let i = 0; i <= cells; i++) {
    const p = (i * size) / cells;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  const normal = createNormalMapFromNoise(size, 1.0, rng);
  return { map: finish(canvas, { srgb: true, anisotropy }), normalMap: finish(normal, { srgb: false, anisotropy }) };
}

export function createGrassMap(size: number, anisotropy: number, seed = 5): Texture {
  const rng = new Random(seed);
  const { canvas, ctx } = createCanvas(size, size);
  noiseFill(ctx, size, size, [62, 92, 44], 16, rng);
  // patches
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(${70 + rng.int(0, 30)},${100 + rng.int(0, 30)},${40 + rng.int(0, 20)},0.35)`;
    ctx.beginPath();
    ctx.ellipse(rng.range(0, size), rng.range(0, size), rng.range(size * 0.05, size * 0.15), rng.range(size * 0.03, size * 0.1), rng.range(0, Math.PI), 0, Math.PI * 2);
    ctx.fill();
  }
  return finish(canvas, { srgb: true, anisotropy });
}

/** Tangent-space normal map from smoothed random height noise (Sobel). */
function createNormalMapFromNoise(size: number, strength: number, rng: Random): HTMLCanvasElement {
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = rng.next();
  // one box-blur pass to get larger features
  const blurred = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += height[((y + dy + size) % size) * size + ((x + dx + size) % size)]!;
        }
      }
      blurred[y * size + x] = sum / 9;
    }
  }
  const { canvas, ctx } = createCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const h = (x: number, y: number) => blurred[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      // normal = normalize(-dx, -dy, 1)
      const len = Math.hypot(dx, dy, 1);
      const nx = -dx / len;
      const ny = -dy / len;
      const nz = 1 / len;
      const i = (y * size + x) * 4;
      d[i] = clamp255((nx * 0.5 + 0.5) * 255);
      d[i + 1] = clamp255((ny * 0.5 + 0.5) * 255);
      d[i + 2] = clamp255((nz * 0.5 + 0.5) * 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Tiled greyscale puddle mask (single channel, replicated to RGB so it can share the same texture
 * pipeline as everything else): irregular blobs from thresholded, smoothed value noise, RepeatWrapping
 * so it tiles seamlessly across the whole road network. Sampled by the wet-road material patch
 * (`world/CityBuilder.ts`) to push roughness toward ~0.02 and flatten the normal inside puddles —
 * see `docs/tasks/08-weather-wet-roads.md`. `NoColorSpace` (it's a mask, not colour data).
 */
export function createPuddleMask(size: number, anisotropy: number, seed = 6): Texture {
  const { canvas, ctx } = createCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  // Two octaves of tileable value noise (valueNoise2D already wraps on integer cell boundaries, so
  // sampling at integer-periodic coordinates gives a seamlessly tiling field), thresholded into
  // rounded blob shapes with a soft edge.
  const cells = Math.max(4, Math.round(size / 48));
  const noiseSeed = seed * 7919 + 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * cells;
      const v = (y / size) * cells;
      const n1 = valueNoise2D(u, v, noiseSeed);
      const n2 = valueNoise2D(u * 2.3 + 11, v * 2.3 + 7, noiseSeed + 1) * 0.5;
      const n = (n1 + n2) / 1.5;
      const mask = clamp255((smoothstep01(n, 0.42, 0.58) ) * 255);
      const i = (y * size + x) * 4;
      d[i] = mask;
      d[i + 1] = mask;
      d[i + 2] = mask;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(canvas, { srgb: false, anisotropy });
}

function smoothstep01(x: number, lo: number, hi: number): number {
  const t = x < lo ? 0 : x > hi ? 1 : (x - lo) / (hi - lo);
  return t * t * (3 - 2 * t);
}

/** Small round glow sprite for lamp heads / headlights (alpha radial gradient). */
export function createGlowSprite(size = 64): Texture {
  const { canvas, ctx } = createCanvas(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
