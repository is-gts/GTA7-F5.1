/**
 * Procedural atmospheric sky (Preetham model via three's Sky addon) plus an image-based
 * lighting environment generated from it with PMREM. The environment gives PBR materials
 * physically plausible specular reflections (car paint, glass) without any HDRI download.
 */
import { Color, MathUtils, PMREMGenerator, Scene, Vector3, type Texture, type WebGLRenderTarget, type WebGLRenderer } from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/**
 * The Preetham sky shader outputs radiance in arbitrary units that are roughly 5-10x brighter
 * than our lit surfaces; scale it into the same HDR range so tone mapping and bloom treat sky and
 * ground consistently, and clamp so the sun disc stays finite in half-float buffers.
 */
export const SKY_RADIANCE_SCALE = 0.2;
export const SKY_RADIANCE_MAX = 48;

function patchSkyMaterial(sky: Sky, scale: number, max: number): void {
  const mat = sky.material;
  mat.uniforms['uSkyScale'] = { value: scale };
  mat.uniforms['uSkyMax'] = { value: max };
  mat.fragmentShader = mat.fragmentShader
    .replace('uniform float showSunDisc;', 'uniform float showSunDisc;\nuniform float uSkyScale;\nuniform float uSkyMax;')
    .replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( min( texColor * uSkyScale, vec3( uSkyMax ) ), 1.0 );');
  if (!mat.fragmentShader.includes('uSkyScale')) throw new Error('Sky shader patch failed: three.js Sky shader layout changed');
  mat.needsUpdate = true;
}

export class SkyDome {
  readonly sky: Sky;
  private readonly envSky: Sky;
  private readonly envScene = new Scene();
  private readonly pmrem: PMREMGenerator;
  private envTarget: WebGLRenderTarget | null = null;
  readonly sunPosition = new Vector3();
  elevation = 40;
  azimuth = 60;

  constructor(private readonly renderer: WebGLRenderer) {
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    this.sky.name = 'sky';
    patchSkyMaterial(this.sky, SKY_RADIANCE_SCALE, SKY_RADIANCE_MAX);
    this.envSky = new Sky();
    this.envSky.scale.setScalar(20000);
    // The environment map must not contain the sun disc: its radiance (~2e7) overflows half-float
    // render targets to +Inf, which PMREM's mip blur then spreads as NaN over the whole map and
    // turns every PBR surface black. The directional light provides the sun's contribution.
    this.envSky.material.uniforms['showSunDisc']!.value = 0;
    patchSkyMaterial(this.envSky, SKY_RADIANCE_SCALE, SKY_RADIANCE_MAX);
    this.envScene.add(this.envSky);
    this.pmrem = new PMREMGenerator(renderer);
    this.setSun(this.elevation, this.azimuth);
    this.setAtmosphere({ turbidity: 4, rayleigh: 1.6, mieCoefficient: 0.004, mieDirectionalG: 0.85 });
  }

  setAtmosphere(p: { turbidity?: number; rayleigh?: number; mieCoefficient?: number; mieDirectionalG?: number }): void {
    for (const s of [this.sky, this.envSky]) {
      const u = s.material.uniforms;
      if (p.turbidity !== undefined) u['turbidity']!.value = p.turbidity;
      if (p.rayleigh !== undefined) u['rayleigh']!.value = p.rayleigh;
      if (p.mieCoefficient !== undefined) u['mieCoefficient']!.value = p.mieCoefficient;
      if (p.mieDirectionalG !== undefined) u['mieDirectionalG']!.value = p.mieDirectionalG;
    }
  }

  setSun(elevationDeg: number, azimuthDeg: number): void {
    this.elevation = elevationDeg;
    this.azimuth = azimuthDeg;
    const phi = MathUtils.degToRad(90 - elevationDeg);
    const theta = MathUtils.degToRad(azimuthDeg);
    this.sunPosition.setFromSphericalCoords(1, phi, theta);
    for (const s of [this.sky, this.envSky]) {
      (s.material.uniforms['sunPosition']!.value as Vector3).copy(this.sunPosition);
    }
  }

  /** Unit vector toward the sun (matches Lighting.sunDirection convention). */
  get sunDirection(): Vector3 {
    return this.sunPosition.clone().normalize();
  }

  /** Rebuild the PMREM environment. Expensive (a few ms on a GPU, more on software GL). */
  updateEnvironment(): Texture {
    const old = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
    old?.dispose();
    return this.envTarget.texture;
  }

  get environment(): Texture | null {
    return this.envTarget?.texture ?? null;
  }

  /** Approximate horizon colour for fog, blending day → dusk → night by sun elevation. */
  horizonColor(out = new Color()): Color {
    const t = MathUtils.clamp(this.elevation / 30, 0, 1);
    const night = new Color(0x0b0f1a);
    const dusk = new Color(0xd9925c);
    const day = new Color(0xbfd3ea);
    if (this.elevation <= 0) return out.copy(night).lerp(dusk, MathUtils.clamp(1 + this.elevation / 8, 0, 1) * 0.5);
    return out.copy(dusk).lerp(day, t);
  }

  /** Sun light colour: warmer near the horizon. */
  sunColor(out = new Color()): Color {
    const t = MathUtils.clamp(this.elevation / 35, 0, 1);
    return out.copy(new Color(0xffa860)).lerp(new Color(0xfff4e0), t);
  }

  /** Sun intensity: fades out at the horizon. */
  sunIntensity(): number {
    return 2.8 * MathUtils.smoothstep(this.elevation, -2, 12);
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.envSky.geometry.dispose();
    this.envSky.material.dispose();
  }
}
