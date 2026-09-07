/**
 * Compact screen-space reflections for wet roads (high/ultra only — see `QualitySettings.ssr`).
 *
 * Two render steps per frame, both at `ssrScale` resolution (a fraction of the main HDR target):
 *  1. A small G-buffer: the scene re-rendered with `scene.overrideMaterial` set to a minimal shader
 *     that outputs world-space normals (RGB, 0..1 packed) plus its own `DepthTexture` — the same
 *     "second scene render with a MeshNormalMaterial-like override" the task doc calls for, with
 *     manual `USE_INSTANCING` support so instanced buildings/props still land in the right place
 *     (three sets that `#define` per-object regardless of the override material).
 *  2. A reflection resolve: for each texel, reconstruct world position from the G-buffer depth,
 *     decide "is this a wet, near-ground, upward-facing surface" purely geometrically (no per-
 *     material roughness authoring needed — only roads/ground/sidewalks are ever wet in this game),
 *     and — if so — ray-march the reflection vector through the G-buffer depth (~24 steps + a fixed
 *     binary-search refinement, mirroring `SSRMath.ts`'s pure reference algorithm) to find a hit,
 *     then sample the *input* scene colour (this pass's `readBuffer`, already lit) at the hit UV.
 *
 * The result (premultiplied by reflectivity × Fresnel × wetness × an edge fade) is composited onto
 * the full-resolution scene colour in a third, trivial full-screen pass — before bloom, so bright
 * reflected windows/lamps can still bloom same as the real thing.
 */
import {
  DepthFormat,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  NearestFilter,
  ShaderMaterial,
  UnsignedIntType,
  Vector3,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

export interface SSRPassOptions {
  /** G-buffer / reflection-buffer resolution multiplier relative to the main target (0.25..1). */
  scale?: number;
  /** Ray march steps (compile-time cap `MAX_STEPS`; the task spec calls for ~24). */
  steps?: number;
  /** World-space max travel distance (m) for a reflection ray. */
  maxDistance?: number;
  /** World-space "already behind geometry, but not too far behind it" hit window (m). */
  thickness?: number;
}

/** Compile-time loop cap in the ray-march shader (kept small so SwiftShader stays fast); the
 *  `uSteps` uniform (<= this) controls how many are actually taken. */
const MAX_STEPS = 32;
const BINARY_STEPS = 5;

// Three's own vertex prefix already declares \`attribute mat4 instanceMatrix;\` under
// \`#ifdef USE_INSTANCING\` (see WebGLProgram.js) whenever the rendered object is an InstancedMesh,
// regardless of material — redeclaring it here is a compile error ("redefinition").
const GBUFFER_VERTEX = /* glsl */ `
  varying vec3 vWorldNormal;
  void main() {
    vec3 objectNormal = normal;
    #ifdef USE_INSTANCING
      mat3 instanceNormalMatrix = mat3(instanceMatrix);
      objectNormal = instanceNormalMatrix * objectNormal;
    #endif
    vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
    vec4 localPosition = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      localPosition = instanceMatrix * localPosition;
    #endif
    vec4 worldPosition = modelMatrix * localPosition;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const GBUFFER_FRAGMENT = /* glsl */ `
  varying vec3 vWorldNormal;
  void main() {
    gl_FragColor = vec4(normalize(vWorldNormal) * 0.5 + 0.5, 1.0);
  }
`;

const RESOLVE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RESOLVE_FRAGMENT = /* glsl */ `
  #define MAX_STEPS ${MAX_STEPS}
  #define BINARY_STEPS ${BINARY_STEPS}
  uniform sampler2D tGNormal;
  uniform sampler2D tGDepth;
  uniform sampler2D tSceneColor;
  uniform mat4 invViewProjection;
  uniform mat4 viewProjection;
  uniform vec3 cameraPos;
  uniform float uWetness;
  uniform float uMaxDistance;
  uniform int uSteps;
  uniform float uThickness;
  varying vec2 vUv;

  vec3 worldFromDepth(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 wp = invViewProjection * clip;
    return wp.xyz / wp.w;
  }

  void main() {
    float depth = texture2D(tGDepth, vUv).x;
    if (depth >= 0.9999) { gl_FragColor = vec4(0.0); return; }
    vec3 worldPos = worldFromDepth(vUv, depth);
    vec3 normal = normalize(texture2D(tGNormal, vUv).rgb * 2.0 - 1.0);

    // Purely geometric "is this a wet reflective surface" mask: near-ground (roads/sidewalks/
    // ground, all built within ~0.2 m of y=0 — see world/CityBuilder.ts) and upward-facing. No
    // per-material roughness read needed since only ground surfaces are ever wet in this game.
    float groundFactor = 1.0 - smoothstep(0.05, 0.6, worldPos.y);
    float upFactor = smoothstep(0.55, 0.92, normal.y);
    float reflectivity = uWetness * groundFactor * upFactor;
    if (reflectivity < 0.015) { gl_FragColor = vec4(0.0); return; }

    vec3 viewDir = normalize(worldPos - cameraPos);
    vec3 reflectDir = reflect(viewDir, normal);
    float ndotv = clamp(dot(normal, -viewDir), 0.0, 1.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - ndotv, 5.0);

    vec3 rayOrigin = worldPos + normal * 0.06;
    float stepLen = uMaxDistance / float(uSteps);
    vec3 rayStep = reflectDir * stepLen;

    vec3 prevPos = rayOrigin;
    vec3 curPos = rayOrigin;
    bool hit = false;
    vec2 hitUv = vec2(-1.0);
    float hitFade = 0.0;

    for (int i = 1; i <= MAX_STEPS; i++) {
      if (i > uSteps) break;
      curPos = rayOrigin + rayStep * float(i);
      vec4 proj = viewProjection * vec4(curPos, 1.0);
      if (proj.w <= 0.0) break;
      vec2 suv = proj.xy / proj.w * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
      float sceneDepth = texture2D(tGDepth, suv).x;
      if (sceneDepth < 0.9999) {
        vec3 scenePos = worldFromDepth(suv, sceneDepth);
        float rayDist = length(curPos - cameraPos);
        float sceneDist = length(scenePos - cameraPos);
        if (rayDist > sceneDist + 0.02 && rayDist - sceneDist < uThickness) {
          vec3 lo = prevPos;
          vec3 hi = curPos;
          for (int b = 0; b < BINARY_STEPS; b++) {
            vec3 mid = (lo + hi) * 0.5;
            vec4 mproj = viewProjection * vec4(mid, 1.0);
            vec2 muv = mproj.xy / mproj.w * 0.5 + 0.5;
            float mSceneDepth = texture2D(tGDepth, muv).x;
            if (mSceneDepth < 0.9999) {
              vec3 mScenePos = worldFromDepth(muv, mSceneDepth);
              float mRayDist = length(mid - cameraPos);
              float mSceneDist = length(mScenePos - cameraPos);
              if (mRayDist > mSceneDist + 0.02) { hi = mid; } else { lo = mid; }
            } else {
              lo = mid;
            }
          }
          vec4 finalProj = viewProjection * vec4(hi, 1.0);
          hitUv = finalProj.xy / finalProj.w * 0.5 + 0.5;
          hit = true;
          hitFade = 1.0 - float(i) / float(uSteps);
          break;
        }
      }
      prevPos = curPos;
    }

    if (!hit) { gl_FragColor = vec4(0.0); return; }
    vec2 edgeDist = min(hitUv, 1.0 - hitUv);
    float edgeFade = clamp(min(edgeDist.x, edgeDist.y) * 12.0, 0.0, 1.0);
    vec3 hitColor = min(texture2D(tSceneColor, hitUv).rgb, vec3(64.0));
    float alpha = clamp(reflectivity * fresnel * edgeFade * (0.5 + 0.5 * hitFade), 0.0, 1.0);
    gl_FragColor = vec4(hitColor, alpha);
  }
`;

const COMPOSITE_VERTEX = RESOLVE_VERTEX;
const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tReflection;
  varying vec2 vUv;
  void main() {
    vec3 base = texture2D(tScene, vUv).rgb;
    vec4 refl = texture2D(tReflection, vUv);
    vec3 result = mix(base, refl.rgb, clamp(refl.a, 0.0, 1.0));
    gl_FragColor = vec4(min(result, vec3(64.0)), 1.0);
  }
`;

export class SSRPass extends Pass {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  steps: number;
  maxDistance: number;
  thickness: number;
  private wetness = 0;
  private scale: number;
  private width: number;
  private height: number;
  private gWidth = 1;
  private gHeight = 1;

  private readonly gbufferMaterial: ShaderMaterial;
  private gbufferTarget: WebGLRenderTarget;
  private reflectionTarget: WebGLRenderTarget;
  private readonly resolveMaterial: ShaderMaterial;
  private readonly compositeMaterial: ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;
  private readonly _invViewProjection = new Matrix4();
  private readonly _viewProjection = new Matrix4();
  private readonly _cameraPos = new Vector3();

  constructor(scene: Scene, camera: PerspectiveCamera, width: number, height: number, options: SSRPassOptions = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.scale = Math.max(0.1, Math.min(1, options.scale ?? 0.5));
    this.steps = Math.max(1, Math.min(MAX_STEPS, Math.floor(options.steps ?? 24)));
    this.maxDistance = options.maxDistance ?? 40;
    this.thickness = options.thickness ?? 1.2;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.needsSwap = true;

    this.gbufferMaterial = new ShaderMaterial({
      name: 'GTA7.SSRGBuffer',
      vertexShader: GBUFFER_VERTEX,
      fragmentShader: GBUFFER_FRAGMENT,
    });

    this.gbufferTarget = this.createGBufferTarget();
    this.reflectionTarget = this.createReflectionTarget();

    this.resolveMaterial = new ShaderMaterial({
      name: 'GTA7.SSRResolve',
      uniforms: {
        tGNormal: { value: null },
        tGDepth: { value: null },
        tSceneColor: { value: null },
        invViewProjection: { value: new Matrix4() },
        viewProjection: { value: new Matrix4() },
        cameraPos: { value: new Vector3() },
        uWetness: { value: 0 },
        uMaxDistance: { value: this.maxDistance },
        uSteps: { value: this.steps },
        uThickness: { value: this.thickness },
      },
      vertexShader: RESOLVE_VERTEX,
      fragmentShader: RESOLVE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this.compositeMaterial = new ShaderMaterial({
      name: 'GTA7.SSRComposite',
      uniforms: { tScene: { value: null }, tReflection: { value: null } },
      vertexShader: COMPOSITE_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this.fsQuad = new FullScreenQuad(this.resolveMaterial);
  }

  /** Rain/road wetness (0..1) — road puddles reflect proportionally to how wet they are. */
  setWetness(w: number): void {
    this.wetness = Math.max(0, Math.min(1, w));
  }

  private createGBufferTarget(): WebGLRenderTarget {
    this.gWidth = Math.max(1, Math.floor(this.width * this.scale));
    this.gHeight = Math.max(1, Math.floor(this.height * this.scale));
    const depthTexture = new DepthTexture(this.gWidth, this.gHeight, UnsignedIntType);
    depthTexture.format = DepthFormat;
    depthTexture.minFilter = NearestFilter;
    depthTexture.magFilter = NearestFilter;
    const target = new WebGLRenderTarget(this.gWidth, this.gHeight, {
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
    });
    target.texture.name = 'GTA7.ssr.gbuffer';
    target.texture.minFilter = NearestFilter;
    target.texture.magFilter = NearestFilter;
    return target;
  }

  private createReflectionTarget(): WebGLRenderTarget {
    const target = new WebGLRenderTarget(this.gWidth, this.gHeight, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    target.texture.name = 'GTA7.ssr.reflection';
    return target;
  }

  override setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.gbufferTarget.dispose();
    this.reflectionTarget.dispose();
    this.gbufferTarget = this.createGBufferTarget();
    this.reflectionTarget = this.createReflectionTarget();
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const prevTarget = renderer.getRenderTarget();
    const prevOverride = this.scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    const prevBackground = this.scene.background;
    renderer.autoClear = false;

    // 1. G-buffer: world normals + depth, at reduced resolution. No scene background (it would
    //    otherwise write a "surface" at the far plane for every sky pixel); no fog/tone mapping
    //    concerns — this target only ever stores packed normals.
    this.scene.background = null;
    this.scene.overrideMaterial = this.gbufferMaterial;
    renderer.setRenderTarget(this.gbufferTarget);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBackground;

    // 2. Reflection resolve, same reduced resolution, reading this frame's incoming scene colour
    //    (readBuffer, full resolution — UV addressing is resolution-independent).
    this.camera.getWorldPosition(this._cameraPos);
    this._viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this._invViewProjection.multiplyMatrices(this.camera.matrixWorld, this.camera.projectionMatrixInverse);
    const ru = this.resolveMaterial.uniforms;
    ru.tGNormal!.value = this.gbufferTarget.texture;
    ru.tGDepth!.value = this.gbufferTarget.depthTexture;
    ru.tSceneColor!.value = readBuffer.texture;
    (ru.invViewProjection!.value as Matrix4).copy(this._invViewProjection);
    (ru.viewProjection!.value as Matrix4).copy(this._viewProjection);
    (ru.cameraPos!.value as Vector3).copy(this._cameraPos);
    ru.uWetness!.value = this.wetness;
    ru.uMaxDistance!.value = this.maxDistance;
    ru.uSteps!.value = this.steps;
    ru.uThickness!.value = this.thickness;

    renderer.setRenderTarget(this.reflectionTarget);
    renderer.clear(true, false, false);
    this.fsQuad.material = this.resolveMaterial;
    this.fsQuad.render(renderer);

    // 3. Composite the (upscaled-by-bilinear-sampling) reflection buffer onto the full-resolution
    //    scene colour.
    const cu = this.compositeMaterial.uniforms;
    cu.tScene!.value = readBuffer.texture;
    cu.tReflection!.value = this.reflectionTarget.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (!this.renderToScreen) renderer.clear(true, false, false);
    this.fsQuad.material = this.compositeMaterial;
    this.fsQuad.render(renderer);

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  override dispose(): void {
    this.gbufferTarget.dispose();
    this.reflectionTarget.dispose();
    this.gbufferMaterial.dispose();
    this.resolveMaterial.dispose();
    this.compositeMaterial.dispose();
    this.fsQuad.dispose();
  }
}
