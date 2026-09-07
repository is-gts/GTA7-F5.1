import { PerspectiveCamera, Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { getPreset } from '../src/core/Quality';
import { Lighting } from '../src/render/Lighting';
import { MaterialRegistry } from '../src/render/MaterialRegistry';

/**
 * `CSM.dispose()` (three/addons/csm/CSM.js) only tears down its shader/material-patch bookkeeping —
 * it never frees the shadow map render target each cascade's `DirectionalLight` lazily allocates
 * once it actually casts a shadow. `DirectionalLight.dispose()` does cascade to `shadow.dispose()`
 * (which frees the map), so `Lighting` must call `.dispose()` on every cascade light itself before
 * dropping the CSM instance, or every switch into/out of 'csm' mode leaks one texture per cascade
 * (caught the hard way: `renderer.info.memory.textures` crept up every quality-switch round trip in
 * the e2e leak-check test). None of this touches the GPU, so it's plain-object testable here.
 */
describe('Lighting CSM cascade disposal', () => {
  it('disposes every cascade DirectionalLight when rebuilding away from csm mode', () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const registry = new MaterialRegistry();
    const lighting = new Lighting(scene, camera, registry, getPreset('high')); // shadows: 'csm'
    expect(lighting.csm).not.toBeNull();
    const lights = lighting.csm!.lights.slice();
    expect(lights.length).toBe(getPreset('high').shadowCascades);
    const disposeSpies = lights.map((l) => vi.spyOn(l, 'dispose'));

    lighting.rebuild(getPreset('low')); // 'single' shadow mode — csm is torn down

    for (const spy of disposeSpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(lighting.csm).toBeNull();
  });

  it('disposes cascade lights again when rebuilding csm -> csm with a different cascade count', () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const registry = new MaterialRegistry();
    const lighting = new Lighting(scene, camera, registry, getPreset('medium')); // 2 cascades
    const firstLights = lighting.csm!.lights.slice();
    const disposeSpies = firstLights.map((l) => vi.spyOn(l, 'dispose'));

    lighting.rebuild(getPreset('ultra')); // 4 cascades — still csm, but a fresh CSM instance

    for (const spy of disposeSpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(lighting.csm!.lights.length).toBe(getPreset('ultra').shadowCascades);
  });

  it('fully disposes on Lighting.dispose() too (not just rebuild)', () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const registry = new MaterialRegistry();
    const lighting = new Lighting(scene, camera, registry, getPreset('high'));
    const lights = lighting.csm!.lights.slice();
    const disposeSpies = lights.map((l) => vi.spyOn(l, 'dispose'));

    lighting.dispose();

    for (const spy of disposeSpies) expect(spy).toHaveBeenCalledTimes(1);
  });
});
