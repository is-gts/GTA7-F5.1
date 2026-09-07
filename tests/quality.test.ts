import { describe, expect, it } from 'vitest';
import {
  AdaptiveResolution,
  QUALITY_PRESETS,
  detectQualityPreset,
  getPreset,
  loadSavedQuality,
  saveQuality,
  type DeviceInfo,
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
