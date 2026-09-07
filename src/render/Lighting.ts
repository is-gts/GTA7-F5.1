/**
 * Sun / sky lighting with three shadow strategies selected by quality:
 *  - 'csm'    : cascaded shadow maps (2-4 cascades) — crisp shadows out to `shadowDistance`
 *  - 'single' : one directional shadow map that follows the focus point (texel-snapped)
 *  - 'none'   : no shadow maps
 */
import { Color, DirectionalLight, Fog, HemisphereLight, Object3D, PerspectiveCamera, Scene, Vector3 } from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import type { QualitySettings } from '../core/Quality';
import type { MaterialRegistry } from './MaterialRegistry';

export interface SunParams {
  /** Elevation above the horizon in degrees. */
  elevation: number;
  /** Azimuth in degrees (0 = +Z, 90 = +X). */
  azimuth: number;
  color: Color;
  intensity: number;
}

const _dir = new Vector3();
const _snap = new Vector3();

export class Lighting {
  readonly hemi: HemisphereLight;
  csm: CSM | null = null;
  sun: DirectionalLight | null = null;
  /** Unit vector pointing from the scene toward the sun. */
  readonly sunDirection = new Vector3(0.4, 0.7, 0.5).normalize();
  private mode: QualitySettings['shadows'] = 'none';
  private shadowDistance = 100;
  private mapSize = 1024;
  private readonly sunTarget = new Object3D();

  constructor(
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera,
    private readonly registry: MaterialRegistry,
    quality: QualitySettings,
  ) {
    this.hemi = new HemisphereLight(0x9fc4ff, 0x6b6b5a, 0.6);
    scene.add(this.hemi);
    scene.add(this.sunTarget);
    this.rebuild(quality);
  }

  /** (Re)create shadow-casting lights for a quality preset. */
  rebuild(q: QualitySettings): void {
    this.disposeLights();
    this.mode = q.shadows;
    this.shadowDistance = q.shadowDistance;
    this.mapSize = q.shadowMapSize;
    this.hemi.intensity = q.envReflections ? 0.35 : 0.85;

    if (q.shadows === 'csm') {
      const csm = new CSM({
        camera: this.camera,
        parent: this.scene,
        cascades: q.shadowCascades,
        maxFar: q.shadowDistance,
        mode: 'practical',
        shadowMapSize: q.shadowMapSize,
        lightDirection: this.sunDirection.clone().negate(),
        lightIntensity: 2.6,
        lightMargin: 160,
        lightNear: 1,
        lightFar: 1200,
        shadowBias: -0.00015,
      });
      csm.fade = true;
      for (const l of csm.lights) {
        l.shadow.normalBias = 0.03;
        l.shadow.radius = q.softShadows ? 3 : 1;
      }
      csm.updateFrustums();
      this.csm = csm;
      this.registry.setCSM(csm);
    } else {
      this.registry.setCSM(null);
      const sun = new DirectionalLight(0xffffff, 2.6);
      sun.castShadow = q.shadows === 'single';
      if (sun.castShadow) {
        const half = q.shadowDistance / 2;
        const cam = sun.shadow.camera;
        cam.left = -half;
        cam.right = half;
        cam.top = half;
        cam.bottom = -half;
        cam.near = 1;
        cam.far = 600;
        sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
        sun.shadow.bias = -0.0002;
        sun.shadow.normalBias = 0.04;
        sun.shadow.radius = q.softShadows ? 3 : 1;
      }
      sun.target = this.sunTarget;
      this.scene.add(sun);
      this.sun = sun;
    }
    this.applySunToLights();
  }

  setSun(params: Partial<SunParams>): void {
    if (params.elevation !== undefined || params.azimuth !== undefined) {
      const el = ((params.elevation ?? 40) * Math.PI) / 180;
      const az = ((params.azimuth ?? 60) * Math.PI) / 180;
      this.sunDirection.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    }
    this.applySunToLights(params.color, params.intensity);
  }

  private applySunToLights(color?: Color, intensity?: number): void {
    if (this.csm) {
      this.csm.lightDirection.copy(this.sunDirection).negate();
      for (const l of this.csm.lights) {
        if (color) l.color.copy(color);
        if (intensity !== undefined) l.intensity = intensity;
      }
    }
    if (this.sun) {
      if (color) this.sun.color.copy(color);
      if (intensity !== undefined) this.sun.intensity = intensity;
    }
  }

  setHemisphere(sky: Color, ground: Color, intensity?: number): void {
    this.hemi.color.copy(sky);
    this.hemi.groundColor.copy(ground);
    if (intensity !== undefined) this.hemi.intensity = intensity;
  }

  setFog(color: Color, near: number, far: number): void {
    const fog = this.scene.fog as Fog | null;
    if (fog && (fog as Fog).isFog) {
      fog.color.copy(color);
      fog.near = near;
      fog.far = far;
    } else {
      this.scene.fog = new Fog(color, near, far);
    }
  }

  /** Call once per frame after the camera's world matrix is up to date. */
  update(focus: Vector3): void {
    if (this.csm) {
      this.csm.update();
      return;
    }
    if (this.sun && this.sun.castShadow) {
      // Snap the shadow camera to its texel grid (in light space) to avoid shimmering edges.
      const texel = this.shadowDistance / this.mapSize;
      const light = this.sun;
      _dir.copy(this.sunDirection);
      // Build a light-space basis: forward = -sunDir, right = up x forward, up' = forward x right.
      const fx = -_dir.x, fy = -_dir.y, fz = -_dir.z;
      let rx = 0 * fz - 1 * fy, ry = 1 * fx - 0 * fz, rz = 0 * fy - 0 * fx; // (0,1,0) x f
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl; ry /= rl; rz /= rl;
      const ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx; // f x r
      const pr = focus.x * rx + focus.y * ry + focus.z * rz;
      const pu = focus.x * ux + focus.y * uy + focus.z * uz;
      const pf = focus.x * fx + focus.y * fy + focus.z * fz;
      const sr = Math.round(pr / texel) * texel;
      const su = Math.round(pu / texel) * texel;
      _snap.set(sr * rx + su * ux + pf * fx, sr * ry + su * uy + pf * fy, sr * rz + su * uz + pf * fz);
      this.sunTarget.position.copy(_snap);
      light.position.copy(_snap).addScaledVector(this.sunDirection, 300);
      this.sunTarget.updateMatrixWorld();
    } else if (this.sun) {
      this.sunTarget.position.copy(focus);
      this.sun.position.copy(focus).addScaledVector(this.sunDirection, 300);
      this.sunTarget.updateMatrixWorld();
    }
  }

  /** Must be called when the camera projection (fov/aspect/near/far) changes. */
  onCameraChanged(): void {
    this.csm?.updateFrustums();
  }

  get shadowMode(): QualitySettings['shadows'] {
    return this.mode;
  }

  private disposeLights(): void {
    if (this.csm) {
      this.csm.remove();
      // `CSM.dispose()` only tears down its shader/material patching bookkeeping — it never frees
      // the shadow map render target each cascade's `DirectionalLight` lazily allocated once it
      // actually cast a shadow. Left alone, every switch into/out of 'csm' mode leaks one texture
      // per cascade (`renderer.info.memory.textures` only grows). `DirectionalLight.dispose()` does
      // cascade to `shadow.dispose()`, so disposing each light here closes that gap.
      for (const l of this.csm.lights) l.dispose();
      this.csm.dispose();
      this.csm = null;
    }
    if (this.sun) {
      this.scene.remove(this.sun);
      this.sun.dispose();
      this.sun = null;
    }
  }

  dispose(): void {
    this.disposeLights();
    this.registry.setCSM(null);
    this.scene.remove(this.hemi);
    this.scene.remove(this.sunTarget);
  }
}
