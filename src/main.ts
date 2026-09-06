import './style.css';
import { Game } from './game/Game';
import { QUALITY_PRESETS, getPreset, isPresetName, loadSavedQuality } from './core/Quality';
import type { QualityPresetName, QualitySettings } from './core/Quality';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
const hudContainer = document.getElementById('hud');
if (!canvas || !hudContainer) throw new Error('index.html must contain #game canvas and #hud container');

const params = new URLSearchParams(window.location.search);
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

const qualityParam = params.get('quality');
let quality: QualitySettings | 'auto' = isPresetName(qualityParam) ? getPreset(qualityParam) : (loadSavedQuality(storage) ?? 'auto');
// Individual overrides for benchmarking / debugging: ?q.aa=none&q.shadowMapSize=1024&q.bloom=false
for (const [k, v] of params.entries()) {
  if (!k.startsWith('q.')) continue;
  if (quality === 'auto') quality = getPreset('medium');
  const key = k.slice(2) as keyof QualitySettings;
  const parsed: unknown = v === 'true' ? true : v === 'false' ? false : v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
  (quality as unknown as Record<string, unknown>)[key] = parsed;
  quality.preset = 'custom';
}
const seed = Number(params.get('seed') ?? '7');
const cols = params.get('cols');
const rows = params.get('rows');
const tod = params.get('tod');
const autostart = params.get('autostart') !== '0';

const game = new Game({
  canvas,
  hudContainer,
  quality,
  city: {
    seed: Number.isFinite(seed) ? seed : 7,
    ...(cols ? { cols: Math.max(1, Number(cols)) } : {}),
    ...(rows ? { rows: Math.max(1, Number(rows)) } : {}),
  },
  devicePixelRatio: window.devicePixelRatio || 1,
  timeOfDay: tod ? Number(tod) : 14,
  storage,
});

const resize = () => game.resize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', resize);
resize();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) game.engine.resetTiming();
});

if (autostart) game.start();
else game.renderFrame();

/** Debug / automation hooks (used by the Playwright smoke tests). */
const api = {
  ready: true,
  game,
  __presets: QUALITY_PRESETS,
  simulate: (steps: number) => game.simulate(steps),
  renderFrame: () => game.renderFrame(),
  setQuality: (name: QualityPresetName) => game.setQualityPreset(name),
  setKey: (code: string, down: boolean) => game.input.setKey(code, down),
  setTimeOfDay: (h: number) => game.setTimeOfDay(h),
  snapshot: () => {
    const v = game.currentVehicle;
    const p = game.player.state;
    return {
      mode: game.mode,
      quality: game.quality.preset,
      pipeline: game.gfx.pipeline?.info ?? null,
      renderer: game.gfx.stats(),
      shadows: game.lighting.shadowMode,
      player: { x: p.x, z: p.z, heading: p.heading },
      vehicle: v ? { x: v.state.x, z: v.state.z, heading: v.state.heading, speed: v.state.forwardSpeed, damage: v.damage, type: v.type } : null,
      vehicles: game.vehicles.length,
      traffic: game.traffic.stats,
      pedestrians: game.pedestrians.stats,
      city: game.cityView.stats,
      frame: game.engine.stats.frame,
      updates: game.engine.stats.updates,
      fixedDelta: game.engine.fixedDelta,
      wanted: { level: game.wanted.level, heat: game.wanted.heat },
      police: { count: game.police.count, pursuing: game.policePursuing, distance: game.police.nearestDistance(v ? v.state.x : p.x, v ? v.state.z : p.z) },
      busted: game.busted,
      minimap: { redraws: game.minimap.redraws },
    };
  },
  /** Render a frame and sample the default framebuffer: mean/variance of luminance over a grid. */
  readPixels: (grid = 24) => {
    game.renderFrame();
    const gl = game.gfx.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    let dark = 0;
    const rows: number[] = [];
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const x = Math.floor(((gx + 0.5) / grid) * w);
        const y = Math.floor(((gy + 0.5) / grid) * h);
        const i = (y * w + x) * 4;
        const l = (0.2126 * buf[i]! + 0.7152 * buf[i + 1]! + 0.0722 * buf[i + 2]!) / 255;
        sum += l;
        sum2 += l * l;
        n++;
        if (l < 0.02) dark++;
        rows.push(Math.round(l * 100));
      }
    }
    const mean = sum / n;
    return { width: w, height: h, mean, variance: sum2 / n - mean * mean, darkFraction: dark / n, samples: rows };
  },
};
(window as unknown as { __gta7: typeof api }).__gta7 = api;
