import { describe, expect, it } from 'vitest';
import {
  AdaptiveResolution,
  DEFAULT_GAMEPLAY_SETTINGS,
  QUALITY_PRESETS,
  detectQualityPreset,
  getPreset,
  isCustomQuality,
  isGameplaySettingsKey,
  isQualitySettingsKey,
  loadSavedGameplay,
  loadSavedQuality,
  nearestPreset,
  saveQuality,
  type DeviceInfo,
  type GameplaySettings,
} from '../src/core/Quality';

const base: DeviceInfo = {
  gpuRenderer: '',
  deviceMemoryGB: 8,
  hardwareConcurrency: 8,
  isMobile: false,
  devicePixelRatio: 1,
  maxTextureSize: 16384,
};

describe('quality presets', () => {
  it('scale monotonically in cost from low to ultra', () => {
    const order = ['low', 'medium', 'high', 'ultra'] as const;
    for (let i = 1; i < order.length; i++) {
      const a = QUALITY_PRESETS[order[i - 1]!];
      const b = QUALITY_PRESETS[order[i]!];
      expect(b.shadowMapSize).toBeGreaterThanOrEqual(a.shadowMapSize);
      expect(b.drawDistance).toBeGreaterThanOrEqual(a.drawDistance);
      expect(b.maxTraffic).toBeGreaterThanOrEqual(a.maxTraffic);
      expect(b.anisotropy).toBeGreaterThanOrEqual(a.anisotropy);
      expect(b.maxLocalLights).toBeGreaterThanOrEqual(a.maxLocalLights);
      expect(b.rainStreaks).toBeGreaterThanOrEqual(a.rainStreaks);
      expect(b.markerSegments).toBeGreaterThanOrEqual(a.markerSegments);
    }
    expect(QUALITY_PRESETS.low.maxLocalLights).toBe(0);
    expect(QUALITY_PRESETS.medium.maxLocalLights).toBe(4);
    expect(QUALITY_PRESETS.high.maxLocalLights).toBe(8);
    expect(QUALITY_PRESETS.ultra.maxLocalLights).toBe(16);
    expect(QUALITY_PRESETS.low.ao).toBe('none');
    expect(QUALITY_PRESETS.ultra.ao).toBe('gtao');
    expect(QUALITY_PRESETS.low.damageSmoke).toBe(false);
    expect(QUALITY_PRESETS.medium.damageSmoke).toBe(true);
    expect(QUALITY_PRESETS.high.damageSmoke).toBe(true);
    expect(QUALITY_PRESETS.ultra.damageSmoke).toBe(true);
  });

  it('gates SSR to high/ultra only, with sane rain-streak counts everywhere', () => {
    expect(QUALITY_PRESETS.low.ssr).toBe(false);
    expect(QUALITY_PRESETS.medium.ssr).toBe(false);
    expect(QUALITY_PRESETS.high.ssr).toBe(true);
    expect(QUALITY_PRESETS.ultra.ssr).toBe(true);
    for (const name of ['low', 'medium', 'high', 'ultra'] as const) {
      const q = QUALITY_PRESETS[name];
      expect(q.rainStreaks).toBeGreaterThan(0);
      expect(q.ssrScale).toBeGreaterThan(0);
      expect(q.ssrScale).toBeLessThanOrEqual(1);
    }
  });

  it('gives every preset a mission-marker tessellation, cheapest on low', () => {
    // `render/MissionMarkers.ts` reads this instead of branching on the preset name, so a custom
    // (hand-tuned) settings object always has a defined value too.
    for (const name of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(QUALITY_PRESETS[name].markerSegments).toBeGreaterThanOrEqual(3);
    }
    expect(QUALITY_PRESETS.low.markerSegments).toBe(8);
    expect(QUALITY_PRESETS.ultra.markerSegments).toBeGreaterThan(QUALITY_PRESETS.low.markerSegments);
    expect(isQualitySettingsKey('markerSegments')).toBe(true);
  });

  it('getPreset returns a copy', () => {
    const q = getPreset('high');
    q.renderScale = 0.1;
    expect(QUALITY_PRESETS.high.renderScale).toBe(1);
  });

  it('detects software renderers as low', () => {
    expect(detectQualityPreset({ ...base, gpuRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))' })).toBe('low');
  });

  it('detects integrated / mobile / discrete GPUs', () => {
    expect(detectQualityPreset({ ...base, gpuRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)' })).toBe('low');
    expect(detectQualityPreset({ ...base, gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11)' })).toBe('ultra');
    expect(detectQualityPreset({ ...base, gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11)' })).toBe('high');
    expect(detectQualityPreset({ ...base, gpuRenderer: 'Mali-G52', isMobile: true })).toBe('low');
    expect(detectQualityPreset({ ...base, gpuRenderer: 'Apple GPU', isMobile: true, deviceMemoryGB: 6 })).toBe('medium');
    expect(detectQualityPreset({ ...base, gpuRenderer: 'unknown', deviceMemoryGB: 4, hardwareConcurrency: 4 })).toBe('medium');
  });

  it('persists and restores settings', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const q = getPreset('high');
    q.aa = 'fxaa';
    saveQuality(storage, q);
    const loaded = loadSavedQuality(storage);
    expect(loaded?.aa).toBe('fxaa');
    expect(loaded?.shadowMapSize).toBe(2048);
    expect(loadSavedQuality({ getItem: () => 'not json' })).toBeNull();
    expect(loadSavedQuality(null)).toBeNull();
  });
});

describe('isCustomQuality (settings menu custom badge)', () => {
  it('is false for a preset object returned untouched from getPreset', () => {
    for (const name of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(isCustomQuality(getPreset(name))).toBe(false);
    }
  });

  it('is true once any single field diverges from its own named preset', () => {
    const q = getPreset('high');
    q.aa = 'fxaa';
    expect(isCustomQuality(q)).toBe(true);
    const q2 = getPreset('medium');
    q2.shadowMapSize = 4096;
    expect(isCustomQuality(q2)).toBe(true);
    const q3 = getPreset('low');
    q3.maxTraffic = 40;
    expect(isCustomQuality(q3)).toBe(true);
  });

  it('is true whenever preset is already "custom" or an unknown name, even if the fields match a preset', () => {
    const q = getPreset('medium');
    q.preset = 'custom';
    expect(isCustomQuality(q)).toBe(true);
    const q2 = { ...getPreset('low'), preset: 'nonsense' } as unknown as ReturnType<typeof getPreset>;
    expect(isCustomQuality(q2)).toBe(true);
  });

  it('reverting the only diverged field back to the preset value makes it non-custom again', () => {
    const q = getPreset('ultra');
    q.bloom = false;
    expect(isCustomQuality(q)).toBe(true);
    q.bloom = true;
    expect(isCustomQuality(q)).toBe(false);
  });
});

describe('isQualitySettingsKey / isGameplaySettingsKey (Menu.set routing)', () => {
  it('recognises every QualitySettings field, including preset, and rejects gameplay/unknown keys', () => {
    for (const k of Object.keys(getPreset('low'))) expect(isQualitySettingsKey(k)).toBe(true);
    expect(isQualitySettingsKey('fov')).toBe(false);
    expect(isQualitySettingsKey('notAField')).toBe(false);
  });

  it('recognises every GameplaySettings field and rejects quality/unknown keys', () => {
    for (const k of Object.keys(DEFAULT_GAMEPLAY_SETTINGS)) expect(isGameplaySettingsKey(k)).toBe(true);
    expect(isGameplaySettingsKey('aa')).toBe(false);
    expect(isGameplaySettingsKey('notAField')).toBe(false);
  });
});

describe('gameplay settings persistence (extends the quality record)', () => {
  it('round-trips gameplay fields saved alongside quality, without disturbing quality fields', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const q = getPreset('ultra');
    q.aa = 'smaa';
    const gameplay: GameplaySettings = { invertMouseY: true, fov: 78, daySpeed: 45, hudPerfOverlay: false };
    saveQuality(storage, q, gameplay);

    const loadedQuality = loadSavedQuality(storage);
    expect(loadedQuality?.aa).toBe('smaa');
    expect(loadedQuality?.shadowMapSize).toBe(4096); // untouched ultra field survives the merge

    const loadedGameplay = loadSavedGameplay(storage);
    expect(loadedGameplay).toEqual(gameplay);
  });

  it('falls back to defaults for a record saved without gameplay fields (pre-existing save)', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveQuality(storage, getPreset('medium')); // no gameplay argument, like the old call sites
    expect(loadSavedGameplay(storage)).toEqual(DEFAULT_GAMEPLAY_SETTINGS);
  });

  it('falls back to defaults for missing storage, invalid JSON, or a wrong-typed field', () => {
    expect(loadSavedGameplay(null)).toEqual(DEFAULT_GAMEPLAY_SETTINGS);
    expect(loadSavedGameplay({ getItem: () => 'not json' })).toEqual(DEFAULT_GAMEPLAY_SETTINGS);
    expect(loadSavedGameplay({ getItem: () => JSON.stringify({ fov: 'not a number', invertMouseY: true }) })).toEqual({
      ...DEFAULT_GAMEPLAY_SETTINGS,
      invertMouseY: true,
    });
  });

  it('clamps a tampered/corrupt daySpeed and fov to the menu slider ranges instead of passing them through', () => {
    // A daySpeed of 0 (or negative) would make TimeOfDay's hour accumulator divide-by-zero into
    // NaN on the next advance() — only reachable via a hand-edited storage record or
    // __gta7.menu.set('daySpeed', 0), since the slider itself clamps to [10, 300].
    const loaded = loadSavedGameplay({ getItem: () => JSON.stringify({ daySpeed: 0, fov: -5 }) });
    expect(loaded.daySpeed).toBeGreaterThanOrEqual(10);
    expect(loaded.fov).toBeGreaterThanOrEqual(55);
    expect(loaded.fov).toBeLessThanOrEqual(90);

    const loadedHigh = loadSavedGameplay({ getItem: () => JSON.stringify({ daySpeed: 1e9, fov: 1e9 }) });
    expect(loadedHigh.daySpeed).toBeLessThanOrEqual(300);
    expect(loadedHigh.fov).toBeLessThanOrEqual(90);
  });

  it('loadSavedQuality does not leak gameplay fields into the returned QualitySettings', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const gameplay: GameplaySettings = { invertMouseY: true, fov: 78, daySpeed: 45, hudPerfOverlay: false };
    saveQuality(storage, getPreset('low'), gameplay);
    const loaded = loadSavedQuality(storage);
    expect(loaded).not.toBeNull();
    for (const k of ['invertMouseY', 'fov', 'daySpeed', 'hudPerfOverlay']) {
      expect(Object.prototype.hasOwnProperty.call(loaded, k)).toBe(false);
    }
  });
});

describe('nearestPreset', () => {
  it('returns the preset itself when the settings still track one', () => {
    for (const name of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(nearestPreset(getPreset(name))).toBe(name);
    }
  });

  it('recovers the origin preset of a customised record (the saved record only says "custom")', () => {
    // What a save looks like after the player nudged one knob: `preset` has become 'custom', so
    // the menu's "Reset to preset" has nothing but the remaining fields to go on.
    expect(nearestPreset({ ...getPreset('ultra'), preset: 'custom', maxTraffic: 0 })).toBe('ultra');
    expect(nearestPreset({ ...getPreset('low'), preset: 'custom', aa: 'none', bloom: true })).toBe('low');
    expect(nearestPreset({ ...getPreset('high'), preset: 'custom', renderScale: 1.5 })).toBe('high');
    expect(nearestPreset({ ...getPreset('medium'), preset: 'custom', shadowDistance: 200 })).toBe('medium');
  });

  it('is stable under the `?q.*` URL overrides that never recorded an origin preset at all', () => {
    // main.ts seeds `?q.*` overrides from medium and stamps preset:'custom'.
    expect(nearestPreset({ ...getPreset('medium'), preset: 'custom', aa: 'none', shadowMapSize: 512 })).toBe('medium');
  });

  it('breaks a tie toward the cheaper preset rather than guessing upward', () => {
    // Build a record exactly midway between low and medium: take low, then flip half of the fields
    // in which the two presets disagree over to medium's values. Its distance to low (the number of
    // flipped fields) is then <= its distance to medium (the number left), so the cheaper preset
    // must win — a "reset to preset" that silently upgraded the player's settings would be worse
    // than one that downgrades them.
    const differing = (Object.keys(QUALITY_PRESETS.low) as (keyof typeof QUALITY_PRESETS.low)[]).filter(
      (k) => k !== 'preset' && QUALITY_PRESETS.low[k] !== QUALITY_PRESETS.medium[k],
    );
    expect(differing.length).toBeGreaterThan(4); // sanity: the two presets really do differ
    const mixed = { ...getPreset('low'), preset: 'custom' as const };
    for (const k of differing.slice(0, Math.floor(differing.length / 2))) {
      (mixed as unknown as Record<string, unknown>)[k] = QUALITY_PRESETS.medium[k];
    }
    expect(nearestPreset(mixed)).toBe('low');
  });
});

describe('AdaptiveResolution', () => {
  it('scales down when frames are slow and back up when fast', () => {
    const ar = new AdaptiveResolution({ initialScale: 1, minScale: 0.5, maxScale: 1, targetFps: 60 });
    for (let i = 0; i < 300; i++) ar.update(1 / 20); // 20 fps
    expect(ar.scale).toBeLessThan(1);
    expect(ar.scale).toBeGreaterThanOrEqual(0.5);
    const low = ar.scale;
    for (let i = 0; i < 1000; i++) ar.update(1 / 200);
    expect(ar.scale).toBeGreaterThan(low);
    expect(ar.scale).toBeLessThanOrEqual(1);
  });

  it('ignores invalid samples and never leaves bounds', () => {
    const ar = new AdaptiveResolution({ initialScale: 0.8, minScale: 0.5, maxScale: 1, targetFps: 60 });
    expect(ar.update(NaN)).toBe(false);
    expect(ar.update(0)).toBe(false);
    for (let i = 0; i < 2000; i++) ar.update(1);
    expect(ar.scale).toBe(0.5);
  });
});
