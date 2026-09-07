/**
 * Rain streaks: a single `InstancedMesh` of thin, elongated quads inside a box volume that follows
 * the camera, animated entirely in the vertex shader from a `time` uniform — falling and wrapping
 * within the box needs no per-particle CPU work each frame, only a container position copy (O(1),
 * the same trick `SkyDome.updateStars` uses for the star field) and one uniform write.
 *
 * Quality-gated by `QualitySettings.rainStreaks` (instance count): rebuilt whenever quality changes
 * (see `Game.applyQuality`), one `InstancedMesh` regardless of count, so it only ever costs one
 * draw call. Intensity (`setIntensity`) drives opacity — `Weather.rainVisual`, not raw `state`, so
 * it fades in/out instead of popping — and the whole mesh is hidden (not just transparent) at 0 so
 * clear-weather frames pay nothing for it.
 */
import {
  AdditiveBlending,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  PlaneGeometry,
  ShaderMaterial,
  type BufferGeometry,
} from 'three';
import type { QualitySettings } from '../core/Quality';
import { Random } from '../world/Random';

/** Half-extent (m) of the box the streaks wrap within, horizontally around the camera. */
const BOX_RADIUS = 45;
/** Full height (m) of the wrap box; streaks fall from `+BOX_HEIGHT/2` to `-BOX_HEIGHT/2` (local). */
const BOX_HEIGHT = 60;
/** Base fall speed (m/s); per-instance varied ±30% via the seed attribute. */
const FALL_SPEED = 26;
/** Streak length (m) and half-width (m) of the local quad geometry. */
const STREAK_LENGTH = 0.7;
const STREAK_HALF_WIDTH = 0.022;
/** Wind lean: streaks fall at this many radians off vertical (baked into the constant "up"/
 *  elongation axis below, not a container rotation — see the billboarding note in `VERTEX_SHADER`). */
const WIND_LEAN = 0.16;

// Each streak is a camera-facing billboard: its local geometry only supplies a *width* offset
// (position.x) and a *length* offset along the fall direction (position.y) — the vertex shader
// reconstructs a "right" vector each frame as `cross(up, viewDir)`, so the streak's width always
// faces the camera regardless of view angle. Without this, a flat quad fixed to one orientation
// goes edge-on (and effectively invisible) from most camera angles. `cameraPosition` and
// `viewMatrix` are three.js's own auto-declared/auto-uploaded uniforms (see WebGLProgram.js) —
// redeclaring them here would be a compile error, same as `instanceMatrix` for instancing.
const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aOffset;
  attribute float aSeed;
  uniform float uTime;
  uniform float uFallSpeed;
  uniform float uBoxHeight;
  varying float vAlpha;
  varying float vFade;
  void main() {
    float speedMul = 0.7 + 0.6 * fract(aSeed * 12.9898);
    float y = mod(aOffset.y - uTime * uFallSpeed * speedMul, uBoxHeight) - uBoxHeight * 0.5;
    vec3 instanceCenter = vec3(aOffset.x, y, aOffset.z);
    vec3 worldCenter = (modelMatrix * vec4(instanceCenter, 1.0)).xyz;

    vec3 up = normalize(vec3(sin(${WIND_LEAN.toFixed(6)}), 1.0, 0.0));
    vec3 viewDir = worldCenter - cameraPosition;
    float viewLen = length(viewDir);
    viewDir = viewLen > 1.0e-5 ? viewDir / viewLen : vec3(0.0, 0.0, 1.0);
    vec3 right = cross(up, viewDir);
    float rightLen = length(right);
    right = rightLen > 1.0e-4 ? right / rightLen : vec3(1.0, 0.0, 0.0);

    vec3 worldPos = worldCenter + right * position.x + up * position.y;
    vAlpha = 0.4 + 0.55 * fract(aSeed * 78.233);
    // Fade the topmost/bottommost slice of the wrap box so streaks don't pop in/out at a hard seam.
    vFade = 1.0 - smoothstep(uBoxHeight * 0.42, uBoxHeight * 0.5, abs(y));
    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform float uIntensity;
  varying float vAlpha;
  varying float vFade;
  void main() {
    float a = vAlpha * vFade * uIntensity;
    if (a <= 0.001) discard;
    gl_FragColor = vec4(vec3(0.8, 0.85, 0.92) * a, a);
  }
`;

function streakGeometry(): BufferGeometry {
  const geo = new PlaneGeometry(STREAK_HALF_WIDTH * 2, STREAK_LENGTH);
  return geo;
}

export class Rain {
  readonly root = new Group();
  private mesh: InstancedMesh | null = null;
  private material: ShaderMaterial | null = null;
  private geometry: BufferGeometry | null = null;
  private count = 0;
  private readonly rng: Random;

  constructor(seed: number, quality: QualitySettings) {
    this.root.name = 'rain';
    this.root.frustumCulled = false;
    this.rng = new Random((seed ^ 0x8a1a1) >>> 0);
    this.rebuild(quality);
  }

  /** Rebuild the instance count for a new quality preset — disposes the previous mesh/material. */
  rebuild(quality: QualitySettings): void {
    this.disposeMesh();
    this.count = Math.max(0, Math.floor(quality.rainStreaks));
    if (this.count === 0) return;
    this.geometry = streakGeometry();
    const aOffset = new Float32Array(this.count * 3);
    const aSeed = new Float32Array(this.count);
    const rng = this.rng;
    for (let i = 0; i < this.count; i++) {
      aOffset[i * 3] = rng.range(-BOX_RADIUS, BOX_RADIUS);
      aOffset[i * 3 + 1] = rng.range(-BOX_HEIGHT * 0.5, BOX_HEIGHT * 0.5);
      aOffset[i * 3 + 2] = rng.range(-BOX_RADIUS, BOX_RADIUS);
      aSeed[i] = rng.next();
    }
    this.geometry.setAttribute('aOffset', new InstancedBufferAttribute(aOffset, 3));
    this.geometry.setAttribute('aSeed', new InstancedBufferAttribute(aSeed, 1));
    this.material = new ShaderMaterial({
      name: 'GTA7.rain',
      uniforms: {
        uTime: { value: 0 },
        uFallSpeed: { value: FALL_SPEED },
        uBoxHeight: { value: BOX_HEIGHT },
        uIntensity: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
      fog: false,
      // The camera-facing billboard reconstruction in the vertex shader doesn't try to preserve a
      // consistent winding order relative to the view direction, so a single-sided material would
      // randomly cull half of all streaks depending on which side of the "right" vector they landed.
      side: DoubleSide,
    });
    this.mesh = new InstancedMesh(this.geometry, this.material, this.count);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.root.add(this.mesh);
  }

  /** Reposition the box on the camera and advance the fall animation. `time` is the deterministic
   *  simulation clock (`Engine.stats.simTime`), not wall time, so headless `simulate()` stepping and
   *  screenshots stay reproducible. */
  update(cameraX: number, cameraY: number, cameraZ: number, time: number, intensity: number): void {
    this.root.position.set(cameraX, cameraY, cameraZ);
    if (!this.mesh || !this.material) return;
    const clamped = Math.max(0, Math.min(1, intensity));
    this.material.uniforms.uTime!.value = time;
    this.material.uniforms.uIntensity!.value = clamped;
    this.mesh.visible = clamped > 0.001;
  }

  private disposeMesh(): void {
    if (this.mesh) this.root.remove(this.mesh);
    this.geometry?.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
    this.geometry = null;
  }

  dispose(): void {
    this.disposeMesh();
    this.root.removeFromParent();
  }
}
