/**
 * GTA-style minimap: a small north-up `<canvas>` in the HUD corner showing the road network around
 * the player, nearby traffic/pedestrians/police as dots, and the player as a rotating arrow.
 *
 * The whole road network (edges as thick lines, blocks as a faint fill) is rendered once into an
 * offscreen canvas at city scale; every redraw is then just one `drawImage` (a scaled crop centred
 * on the player) plus a handful of dots and the arrow — cheap enough to throttle to ~10 Hz without
 * the static layer ever needing to be redrawn again (only `rebuild()`, on a new city/quality
 * change, touches it).
 */
import type { CityData } from '../world/CityGenerator';

export interface MinimapDot {
  x: number;
  z: number;
}

export interface MinimapDrawInput {
  playerX: number;
  playerZ: number;
  playerHeading: number;
  traffic: readonly MinimapDot[];
  pedestrians: readonly MinimapDot[];
  police: readonly MinimapDot[];
  /** Start markers of every still-`'available'` mission (see `game/Missions.ts`). */
  missionStarts: readonly MinimapDot[];
  /** The active mission's current checkpoint, or `null` when no mission is active. */
  missionCheckpoint: MinimapDot | null;
}

/** World-units-per-pixel scale for the cached static layer, capped so the offscreen canvas for a
 *  large city stays a reasonable size. */
export function computeStaticScale(worldWidth: number, worldDepth: number, maxPixels = 1024, maxScale = 2): number {
  const span = Math.max(1, worldWidth, worldDepth);
  return Math.min(maxScale, maxPixels / span);
}

/** Redraws throttled to this many per second (see `Minimap.update`). */
const REDRAW_HZ = 10;
/** Half-width (m) of the world window shown on the visible canvas. */
const VIEW_RANGE = 130;
/** Mission marker colours — the same pair the world marker columns use (`render/MissionMarkers.ts`)
 *  so the minimap and the world agree, and deliberately distinct from the cyan player arrow. */
const MISSION_START_COLOR = '#ff8c2b';
const MISSION_CHECKPOINT_COLOR = '#ff5ce6';

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly staticCanvas: HTMLCanvasElement;
  private readonly staticCtx: CanvasRenderingContext2D;
  private scale = 1;
  private offsetX = 0;
  private offsetZ = 0;
  // Start already at the redraw threshold (not 0) so the very first `update()` call draws
  // immediately — otherwise the minimap shows an empty disc for the first ~1/REDRAW_HZ seconds of
  // wall time (a handful of frames) after boot.
  private accum = 1 / REDRAW_HZ;
  /** Total redraws performed so far — exposed for the e2e throttling assertion. */
  redraws = 0;

  constructor(
    container: HTMLElement,
    private city: CityData,
    private readonly size = 180,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-minimap';
    this.canvas.width = size;
    this.canvas.height = size;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.staticCanvas = document.createElement('canvas');
    this.staticCtx = this.staticCanvas.getContext('2d')!;
    this.buildStatic(city);
  }

  /** Rebuild the cached road/block layer for a new city (or after a seed change). */
  rebuild(city: CityData): void {
    this.city = city;
    this.buildStatic(city);
  }

  private buildStatic(city: CityData): void {
    const b = city.bounds;
    const width = Math.max(1, b.maxX - b.minX);
    const depth = Math.max(1, b.maxZ - b.minZ);
    this.scale = computeStaticScale(width, depth);
    this.offsetX = b.minX;
    this.offsetZ = b.minZ;
    const cw = Math.max(1, Math.round(width * this.scale));
    const ch = Math.max(1, Math.round(depth * this.scale));
    this.staticCanvas.width = cw;
    this.staticCanvas.height = ch;
    const ctx = this.staticCtx;
    ctx.fillStyle = '#14151d';
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (const block of city.blocks) {
      ctx.fillRect(this.px(block.x0), this.pz(block.z0), block.size * this.scale, block.size * this.scale);
    }
    ctx.strokeStyle = 'rgba(215,218,230,0.6)';
    ctx.lineWidth = Math.max(1, 2.4 * this.scale);
    ctx.lineCap = 'round';
    for (const edge of city.roads.edges) {
      const na = city.roads.nodes[edge.a]!;
      const nb = city.roads.nodes[edge.b]!;
      ctx.beginPath();
      ctx.moveTo(this.px(na.x), this.pz(na.z));
      ctx.lineTo(this.px(nb.x), this.pz(nb.z));
      ctx.stroke();
    }
  }

  private px(x: number): number {
    return (x - this.offsetX) * this.scale;
  }

  private pz(z: number): number {
    return (z - this.offsetZ) * this.scale;
  }

  /**
   * Advance the throttle clock and redraw the dynamic layer at most `REDRAW_HZ` times per second.
   * `buildInput` is only called when a redraw is actually due, so the (small) per-entity arrays it
   * builds are not allocated on every frame — just ~`REDRAW_HZ` times a second.
   */
  update(dt: number, buildInput: () => MinimapDrawInput): void {
    this.accum += dt;
    const interval = 1 / REDRAW_HZ;
    if (this.accum < interval) return;
    this.accum = 0;
    this.redraw(buildInput());
  }

  private redraw(input: MinimapDrawInput): void {
    this.redraws++;
    const ctx = this.ctx;
    const size = this.size;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#0a0b11';
    ctx.fillRect(0, 0, size, size);

    const rangePx = VIEW_RANGE * this.scale;
    const cx = this.px(input.playerX);
    const cz = this.pz(input.playerZ);
    ctx.drawImage(this.staticCanvas, cx - rangePx, cz - rangePx, rangePx * 2, rangePx * 2, 0, 0, size, size);

    const worldToScreen = size / (VIEW_RANGE * 2);
    const dot = (p: MinimapDot, color: string, r: number) => {
      const sx = size / 2 + (p.x - input.playerX) * worldToScreen;
      const sy = size / 2 + (p.z - input.playerZ) * worldToScreen;
      if (sx < -r || sx > size + r || sy < -r || sy > size + r) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    };
    // A hollow ring in a colour no other dot uses (not the pedestrians' gold, not the player
    // arrow's cyan) so a mission start reads clearly among traffic/pedestrian dots on a busy
    // minimap, not just as "a slightly bigger gold dot". `clampToRim` keeps a marker that is
    // further away than the minimap's own VIEW_RANGE visible as a direction, pinned to the edge of
    // the disc (mission legs run up to MAX_CHECKPOINT_SPACING = 220 m, well past the 130 m the
    // minimap shows, so the active checkpoint would otherwise simply vanish off the map).
    const ring = (p: MinimapDot, color: string, r: number, clampToRim: boolean) => {
      let sx = size / 2 + (p.x - input.playerX) * worldToScreen;
      let sy = size / 2 + (p.z - input.playerZ) * worldToScreen;
      const dx = sx - size / 2;
      const dy = sy - size / 2;
      const dist = Math.hypot(dx, dy);
      const rim = size / 2 - r - 1.5;
      if (dist > rim) {
        if (!clampToRim) return;
        // dist > rim >= 0 here, so this never divides by zero.
        sx = size / 2 + (dx / dist) * rim;
        sy = size / 2 + (dy / dist) * rim;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
      return { sx, sy };
    };
    for (const p of input.traffic) dot(p, '#d8dbe4', 2.1);
    for (const p of input.pedestrians) dot(p, '#ffd24a', 1.7);
    for (const p of input.police) dot(p, '#3fa9ff', 3.1);
    for (const p of input.missionStarts) ring(p, MISSION_START_COLOR, 4.4, false);
    if (input.missionCheckpoint) {
      // The active checkpoint: a magenta ring with a filled core — the same magenta as its world
      // marker column (`render/MissionMarkers.ts`), and neither the colour nor the shape of the
      // cyan player arrow it sits next to when the player is nearly on top of it.
      const at = ring(input.missionCheckpoint, MISSION_CHECKPOINT_COLOR, 4.6, true);
      if (at) {
        ctx.fillStyle = MISSION_CHECKPOINT_COLOR;
        ctx.beginPath();
        ctx.arc(at.sx, at.sy, 1.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Player arrow: a small triangle at the centre, rotated to heading. Built directly from the
    // project's forward/right vectors rather than ctx.rotate() so the sign convention matches the
    // rest of the codebase exactly (see docs/ARCHITECTURE.md).
    const fx = Math.sin(input.playerHeading);
    const fz = Math.cos(input.playerHeading);
    const rx = -fz;
    const rz = fx;
    const cxp = size / 2;
    const cyp = size / 2;
    const nose = 8;
    const back = 5.5;
    const wing = 5;
    ctx.fillStyle = '#4fd1ff';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cxp + fx * nose, cyp + fz * nose);
    ctx.lineTo(cxp - fx * back + rx * wing, cyp - fz * back + rz * wing);
    ctx.lineTo(cxp - fx * back - rx * wing, cyp - fz * back - rz * wing);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  dispose(): void {
    this.canvas.remove();
  }
}
