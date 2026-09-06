/**
 * Quality presets and scalability knobs.
 *
 * Every expensive rendering feature is driven from a `QualitySettings` object so the game can
 * scale from integrated/mobile GPUs ("low") to discrete GPUs ("ultra").
 */
export type AAMode = 'none' | 'fxaa' | 'smaa' | 'msaa' | 'ssaa' | 'taa';
export type AOMode = 'none' | 'ssao' | 'gtao';
export type ShadowMode = 'none' | 'single' | 'csm';
export type ToneMappingMode = 'aces' | 'agx' | 'neutral';
export type QualityPresetName = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  preset: QualityPresetName | 'custom';
  /** Internal render resolution multiplier relative to the CSS pixel size (0.5..2). */
  renderScale: number;
  /** Upper bound for devicePixelRatio (1 on low-end to avoid 3x pixel counts on phones). */
  maxPixelRatio: number;
  /** Dynamic resolution scaling toward `targetFps`. */
  adaptiveResolution: boolean;
  targetFps: number;
  minRenderScale: number;

  aa: AAMode;
  /** MSAA sample count when aa === 'msaa'. */
  msaaSamples: 2 | 4 | 8;
  ao: AOMode;
  /** AO buffer resolution multiplier (0.5 = half-res AO). */
  aoScale: number;
  bloom: boolean;
  toneMapping: ToneMappingMode;

  shadows: ShadowMode;
  shadowMapSize: 512 | 1024 | 2048 | 4096;
  shadowCascades: 1 | 2 | 3 | 4;
  /** Distance in metres beyond which shadows are not rendered. */
  shadowDistance: number;
  /** Use PCF soft shadows (costlier taps) instead of hard PCF. */
  softShadows: boolean;

  /** Chunk draw distance in metres (full detail). */
  drawDistance: number;
  /** Distant low-detail impostor range beyond drawDistance (metres). */
  farDistance: number;
  anisotropy: 1 | 2 | 4 | 8 | 16;
  /** Environment reflections (PMREM from sky). */
  envReflections: boolean;
  /** Density limits for dynamic agents. */
  maxTraffic: number;
  maxPedestrians: number;
  /** Cap on simultaneously pursuing police cars (`Wanted.policeCountForLevel`) — full-detail
   *  `VehicleEntity`s with a light bar, so the weakest devices carry fewer of them. */
  maxPolice: number;
  /** Number of props (lamps/trees) drawn (0..1 fraction). */
  propDensity: number;
  /** Damage-smoke particle emitter on badly damaged vehicles (cheap `Points`; off on low). */
  damageSmoke: boolean;
}

export const QUALITY_PRESETS: Record<QualityPresetName, QualitySettings> = {
  low: {
    preset: 'low',
    renderScale: 0.75,
    maxPixelRatio: 1,
    adaptiveResolution: true,
    targetFps: 30,
    minRenderScale: 0.5,
    aa: 'fxaa',
    msaaSamples: 2,
    ao: 'none',
    aoScale: 0.5,
    bloom: false,
    toneMapping: 'aces',
    shadows: 'single',
    shadowMapSize: 1024,
    shadowCascades: 1,
    shadowDistance: 80,
    softShadows: false,
    drawDistance: 220,
    farDistance: 500,
    anisotropy: 2,
    envReflections: false,
    maxTraffic: 12,
    maxPedestrians: 16,
    maxPolice: 3,
    propDensity: 0.5,
    damageSmoke: false,
  },
  medium: {
    preset: 'medium',
    renderScale: 1,
    maxPixelRatio: 1.5,
    adaptiveResolution: true,
    targetFps: 60,
    minRenderScale: 0.6,
    aa: 'smaa',
    msaaSamples: 4,
    ao: 'none',
    aoScale: 0.5,
    bloom: true,
    toneMapping: 'aces',
    shadows: 'csm',
    shadowMapSize: 1024,
    shadowCascades: 2,
    shadowDistance: 150,
    softShadows: true,
    drawDistance: 320,
    farDistance: 800,
    anisotropy: 4,
    envReflections: true,
    maxTraffic: 24,
    maxPedestrians: 32,
    maxPolice: 4,
    propDensity: 0.75,
    damageSmoke: true,
  },
  high: {
    preset: 'high',
    renderScale: 1,
    maxPixelRatio: 2,
    adaptiveResolution: false,
    targetFps: 60,
    minRenderScale: 0.7,
    aa: 'smaa',
    msaaSamples: 4,
    ao: 'gtao',
    aoScale: 0.5,
    bloom: true,
    toneMapping: 'aces',
    shadows: 'csm',
    shadowMapSize: 2048,
    shadowCascades: 3,
    shadowDistance: 260,
    softShadows: true,
    drawDistance: 450,
    farDistance: 1200,
    anisotropy: 8,
    envReflections: true,
    maxTraffic: 40,
    maxPedestrians: 48,
    maxPolice: 5,
    propDensity: 1,
    damageSmoke: true,
  },
  ultra: {
    preset: 'ultra',
    renderScale: 1,
    maxPixelRatio: 2,
    adaptiveResolution: false,
    targetFps: 60,
    minRenderScale: 0.8,
    aa: 'msaa',
    msaaSamples: 4,
    ao: 'gtao',
    aoScale: 1,
    bloom: true,
    toneMapping: 'agx',
    shadows: 'csm',
    shadowMapSize: 4096,
    shadowCascades: 4,
    shadowDistance: 400,
    softShadows: true,
    drawDistance: 600,
    farDistance: 1600,
    anisotropy: 16,
    envReflections: true,
    maxTraffic: 60,
    maxPedestrians: 64,
    maxPolice: 5,
    propDensity: 1,
    damageSmoke: true,
  },
};

export function getPreset(name: QualityPresetName): QualitySettings {
  return { ...QUALITY_PRESETS[name] };
}

export interface DeviceInfo {
  /** WEBGL_debug_renderer_info unmasked renderer string (may be empty). */
  gpuRenderer: string;
  /** navigator.deviceMemory in GB (undefined when unavailable). */
  deviceMemoryGB?: number;
  hardwareConcurrency?: number;
  isMobile: boolean;
  devicePixelRatio: number;
  /** Max texture size reported by WebGL. */
  maxTextureSize: number;
}

/**
 * Heuristic preset detection. Pure function so it can be unit-tested.
 * Errs on the side of lower presets: the adaptive resolution and in-game settings allow going up.
 */
export function detectQualityPreset(info: DeviceInfo): QualityPresetName {
  const gpu = info.gpuRenderer.toLowerCase();
  const softwareGpu = /swiftshader|llvmpipe|software|mesa offscreen|basic render/.test(gpu);
  if (softwareGpu) return 'low';
  if (info.isMobile) {
    // Modern flagship mobile GPUs can handle medium; everything else low.
    const strongMobile = /apple gpu|apple a1[5-9]|apple m|adreno \(tm\) 7|adreno 7|immortalis|mali-g7[1-9]|mali-g[89]/.test(gpu);
    return strongMobile && (info.deviceMemoryGB ?? 4) >= 4 ? 'medium' : 'low';
  }
  const integrated = /intel\(r\) (u?hd|iris|hd graphics)|intel hd|intel uhd|intel iris|radeon\(tm\) graphics|vega [3-8]\b|apple m1\b/.test(gpu);
  const highEnd = /rtx (30|40|50)[0-9]0|rtx a|radeon rx (6[7-9]|7[6-9]|8|9)[0-9]{2}|apple m[2-9] (pro|max|ultra)|arc a7/.test(gpu);
  const midRange = /gtx 1[6-9]|gtx 10[6-8]0|rtx 20|rtx 3050|radeon rx (5[5-9]|6[4-6])[0-9]{2}|apple m[1-9]|arc a[3-5]/.test(gpu);
  if (integrated) return 'low';
  if (highEnd) return 'ultra';
  if (midRange) return 'high';
  const mem = info.deviceMemoryGB ?? 8;
  const cores = info.hardwareConcurrency ?? 4;
  if (mem >= 8 && cores >= 8 && info.maxTextureSize >= 8192) return 'high';
  return 'medium';
}

const STORAGE_KEY = 'gta7.quality.v1';

export function loadSavedQuality(storage: Pick<Storage, 'getItem'> | null): QualitySettings | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QualitySettings>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const base = getPreset(isPresetName(parsed.preset) ? parsed.preset : 'medium');
    return { ...base, ...parsed };
  } catch {
    return null;
  }
}

export function saveQuality(storage: Pick<Storage, 'setItem'> | null, q: QualitySettings): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(q));
  } catch {
    /* quota / private mode: ignore */
  }
}

export function isPresetName(v: unknown): v is QualityPresetName {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'ultra';
}

/**
 * Dynamic resolution scaling. Feed it frame times; it nudges `scale` between
 * `minScale` and `maxScale` to hold `targetFps`. Pure and deterministic.
 */
export class AdaptiveResolution {
  scale: number;
  private readonly minScale: number;
  private readonly maxScale: number;
  private readonly targetFrameTime: number;
  private ema: number;
  private cooldown = 0;

  constructor(opts: { initialScale: number; minScale: number; maxScale: number; targetFps: number }) {
    this.scale = opts.initialScale;
    this.minScale = Math.min(opts.minScale, opts.maxScale);
    this.maxScale = opts.maxScale;
    this.targetFrameTime = 1 / Math.max(1, opts.targetFps);
    this.ema = this.targetFrameTime;
  }

  /**
   * @param frameTime measured GPU+CPU frame time in seconds
   * @returns true when `scale` changed
   */
  update(frameTime: number): boolean {
    if (!(frameTime > 0) || !Number.isFinite(frameTime)) return false;
    // Smooth over roughly 20 frames.
    this.ema += (frameTime - this.ema) * 0.05;
    if (this.cooldown > 0) {
      this.cooldown--;
      return false;
    }
    const ratio = this.ema / this.targetFrameTime;
    const prev = this.scale;
    if (ratio > 1.15) {
      // Too slow: scale pixel count down proportionally (sqrt because scale is per-axis).
      this.scale = Math.max(this.minScale, this.scale * Math.max(0.8, 1 / Math.sqrt(ratio)));
      this.cooldown = 30;
    } else if (ratio < 0.8) {
      this.scale = Math.min(this.maxScale, this.scale * 1.05);
      this.cooldown = 60;
    }
    this.scale = Math.round(this.scale * 100) / 100;
    return this.scale !== prev;
  }

  get smoothedFrameTime(): number {
    return this.ema;
  }
}
