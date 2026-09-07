/**
 * Real temporal anti-aliasing: sub-pixel Halton(2,3) camera jitter + history reprojection +
 * neighbourhood clamping. Selected when `QualitySettings.aa === 'taa'` (see `Quality.ts`,
 * `PostPipeline.ts`); replaces the plain `RenderPass` at the front of the pipeline (GTAO/bloom/
 * output still run after it, reading its resolved colour like they would any other scene pass).
 *
 * Per frame:
 *  1. Offset `camera.projectionMatrix.elements[8]`/`[9]` by a Halton(2,3) sample (see
 *     `TAAJitter.ts`), render the scene into an HDR colour+depth target, then restore the
 *     elements immediately — the mutation is synchronous and local to this method, so
 *     `camera.projectionMatrixInverse` (computed elsewhere, only on `updateProjectionMatrix()`)
 *     is never touched and stays consistent with the *unjittered* projection throughout, and
 *     everything else that reads the camera this frame (shadows/CSM, which update earlier in
 *     `Game.render`, and the reprojection math below) sees the unjittered matrix.
 *  2. Reconstruct this pixel's world position from its (jittered-render, but unjittered-
 *     reconstructed) depth, reproject into the *previous* frame's clip space via the stored
 *     previous view-projection matrix, and fetch the history colour there (bilinear, for free
 *     sub-pixel reprojection).
 *  3. Clamp that history sample to the current 3×3 neighbourhood's min/max box in YCoCg (cheaper
 *     and less prone to false-positive rejection than a raw RGB box) and blend it with the fresh
 *     current-frame colour.
 *  4. Reject history (fall back to the current sample alone) when the reprojected UV lands off
 *     screen or behind the previous camera.
 *
 * Deliberately *not* done: a per-pixel "does the reprojected depth match the previous frame's
 * stored depth" disocclusion test. It sounds like the obvious way to catch stale history, but a
 * single hard-edged silhouette pixel (a building against the sky, a car against the road) already
 * disagrees wildly in depth between two different sub-pixel jitter phases of the *same static*
 * frame — coverage flips which surface the jittered sample lands on — so a depth check tight
 * enough to catch real disocclusion also fires on every ordinary static edge, permanently
 * blocking history there and defeating the whole point of temporally supersampling edges.
 *
 * Trade-off (documented per the task spec): there is no per-object velocity buffer, so moving
 * geometry (traffic, the player's car) is *not* explicitly reprojected — a car that moved 3 m this
 * frame reprojects to where the *background* behind its old position was. Correctness instead
 * comes entirely from the neighbourhood clamp: the stale (background) history sample gets clamped
 * into the *current* frame's local colour range (the car's own colours, since that's what's
 * actually there now) before blending, so the result never smears/ghosts — it just falls back
 * toward the un-denoised current sample on fast-moving silhouettes, which is acceptable for a
 * driving game's edges/hood/road detail and much cheaper than a full motion-vector pass.
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
  Vector2,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { buildJitterOffset, TAA_SAMPLE_COUNT } from './TAAJitter';

export interface TAAPassOptions {
  /** Halton(2,3) samples per jitter cycle (8 or 16 per the task spec). Default 8. */
  sampleCount?: number;
  /** Fraction of the clamped history kept each frame (the rest is the fresh current sample);
   *  `QualitySettings.taaBlend`. Default 0.9 (i.e. `mix(history, current, 0.1)`). */
  blend?: number;
}

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RESOLVE_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D tCurrentColor;
  uniform sampler2D tCurrentDepth;
  uniform sampler2D tHistory;
  uniform vec2 resolution;
  uniform mat4 currentInverseViewProjection;
  uniform mat4 prevViewProjectionMatrix;
  uniform float blend;
  uniform float historyValid;

  varying vec2 vUv;

  vec3 rgb2YCoCg(vec3 c) {
    return vec3(
      dot(c, vec3(0.25, 0.5, 0.25)),
      dot(c, vec3(0.5, 0.0, -0.5)),
      dot(c, vec3(-0.25, 0.5, -0.25))
    );
  }

  vec3 yCoCg2rgb(vec3 c) {
    float y = c.x;
    float co = c.y;
    float cg = c.z;
    return vec3(y + co - cg, y + cg, y - co - cg);
  }

  void main() {
    vec2 texel = 1.0 / resolution;

    // 3x3 neighbourhood of the fresh (jittered) current-frame render: a YCoCg min/max box to
    // clamp the reprojected history into (kills ghosting on disocclusion/fast motion without a
    // velocity buffer — see file header). Deliberately no unsharp-mask-style sharpen pass here: it
    // would have to draw its high-frequency detail from this same raw, still-aliased current-frame
    // neighbourhood, which reintroduces exactly the noise the temporal blend just removed.
    vec3 minC = vec3(1.0e6);
    vec3 maxC = vec3(-1.0e6);
    vec3 centerColor = vec3(0.0);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 offset = vec2(float(dx), float(dy)) * texel;
        vec3 c = texture2D(tCurrentColor, vUv + offset).rgb;
        vec3 yc = rgb2YCoCg(c);
        minC = min(minC, yc);
        maxC = max(maxC, yc);
        if (dx == 0 && dy == 0) centerColor = c;
      }
    }

    float depth = texture2D(tCurrentDepth, vUv).x;
    vec4 clipPos = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 worldPos = currentInverseViewProjection * clipPos;
    worldPos /= worldPos.w;

    vec4 prevClip = prevViewProjectionMatrix * worldPos;
    vec3 resolved = centerColor;
    if (historyValid > 0.5 && prevClip.w > 1.0e-5) {
      vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
      bool offscreen = any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)));
      if (!offscreen) {
        // No per-pixel depth-disagreement test here — with sub-pixel jitter alone (no motion) a
        // single hard edge pixel legitimately shows two very different depths from one frame to
        // the next (whichever side of the edge the jittered sample happened to land on), so a
        // depth check tight enough to catch real disocclusion would also constantly reject at
        // every static edge, defeating the point. The neighbourhood clamp below is what actually
        // keeps disoccluded/moving geometry correct (see the file header's documented trade-off).
        vec3 history = texture2D(tHistory, prevUv).rgb;
        vec3 clampedHistory = yCoCg2rgb(clamp(rgb2YCoCg(history), minC, maxC));
        resolved = mix(clampedHistory, centerColor, clamp(1.0 - blend, 0.0, 1.0));
      }
    }

    resolved = clamp(resolved, 0.0, 64.0); // finite HDR — see docs/ARCHITECTURE.md

    gl_FragColor = vec4(resolved, 1.0);
  }
`;

export class TAAPass extends Pass {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  sampleCount: number;
  blend: number;
  /** Halton sample index (0..sampleCount-1) used by the frame just rendered — exposed via
   *  `PostPipeline.info.taaJitterIndex` for `snapshot()`/e2e. */
  jitterIndex = 0;

  private width: number;
  private height: number;
  private readonly sceneTarget: WebGLRenderTarget;
  private readonly historyTargets: [WebGLRenderTarget, WebGLRenderTarget];
  private historyIndex = 0;
  private historyValid = false;
  private frameIndex = 0;
  private readonly resolveMaterial: ShaderMaterial;
  private readonly copyMaterial: ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;
  private readonly _invViewProj = new Matrix4();
  private readonly _prevViewProj = new Matrix4();

  constructor(scene: Scene, camera: PerspectiveCamera, width: number, height: number, options: TAAPassOptions = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.sampleCount = Math.max(1, Math.floor(options.sampleCount ?? TAA_SAMPLE_COUNT));
    this.blend = options.blend ?? 0.9;
    this.needsSwap = true;

    this.sceneTarget = this.createSceneTarget();
    this.historyTargets = [this.createHistoryTarget(), this.createHistoryTarget()];

    this.resolveMaterial = new ShaderMaterial({
      name: 'GTA7.TAAResolve',
      uniforms: {
        tCurrentColor: { value: null },
        tCurrentDepth: { value: null },
        tHistory: { value: null },
        resolution: { value: new Vector2(this.width, this.height) },
        currentInverseViewProjection: { value: new Matrix4() },
        prevViewProjectionMatrix: { value: new Matrix4() },
        blend: { value: this.blend },
        historyValid: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: RESOLVE_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.copyMaterial = new ShaderMaterial({
      name: 'GTA7.TAACopy',
      uniforms: { tDiffuse: { value: null }, opacity: { value: 1 } },
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.resolveMaterial);
  }

  private createSceneTarget(): WebGLRenderTarget {
    const depthTexture = new DepthTexture(this.width, this.height, UnsignedIntType);
    depthTexture.format = DepthFormat;
    depthTexture.minFilter = NearestFilter;
    depthTexture.magFilter = NearestFilter;
    const target = new WebGLRenderTarget(this.width, this.height, {
      type: HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
    });
    target.texture.name = 'GTA7.taa.scene';
    return target;
  }

  private createHistoryTarget(): WebGLRenderTarget {
    const target = new WebGLRenderTarget(this.width, this.height, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    target.texture.name = 'GTA7.taa.history';
    return target;
  }

  override setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.sceneTarget.setSize(this.width, this.height);
    for (const t of this.historyTargets) t.setSize(this.width, this.height);
    (this.resolveMaterial.uniforms.resolution!.value as Vector2).set(this.width, this.height);
    // A resized target invalidates any stored history (different resolution/aspect); restart the
    // jitter cycle too so the first post-resize frame isn't judged against a stale phase.
    this.historyValid = false;
    this.frameIndex = 0;
    this.historyIndex = 0;
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget /*, readBuffer, deltaTime, maskActive */): void {
    const sampleIndex = ((this.frameIndex % this.sampleCount) + this.sampleCount) % this.sampleCount;
    this.jitterIndex = sampleIndex;
    const jitter = buildJitterOffset(sampleIndex, this.sampleCount, this.width, this.height);

    const proj = this.camera.projectionMatrix;
    const e8 = proj.elements[8]!;
    const e9 = proj.elements[9]!;
    // Post-multiplying the projection by a small clip-space translation adds a constant (depth-
    // independent) NDC offset; algebraically that lands exactly on elements[8]/[9] (see
    // TAAJitter.ts's `buildJitterOffset` doc comment).
    proj.elements[8] = e8 - jitter.x;
    proj.elements[9] = e9 - jitter.y;

    const cur = this.sceneTarget;

    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    renderer.autoClear = false;
    renderer.setRenderTarget(cur);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;

    // Restore the exact original elements (never call updateProjectionMatrix() while jittered) so
    // camera.projectionMatrixInverse — used below via the un-mutated projectionMatrix — stays
    // consistent with the camera's real (unjittered) frustum for every other system this frame.
    proj.elements[8] = e8;
    proj.elements[9] = e9;

    this._invViewProj.multiplyMatrices(this.camera.matrixWorld, this.camera.projectionMatrixInverse);

    const historyRead = this.historyTargets[this.historyIndex]!;
    const historyWrite = this.historyTargets[1 - this.historyIndex]!;

    const u = this.resolveMaterial.uniforms;
    u.tCurrentColor!.value = cur.texture;
    u.tCurrentDepth!.value = cur.depthTexture;
    u.tHistory!.value = historyRead.texture;
    (u.currentInverseViewProjection!.value as Matrix4).copy(this._invViewProj);
    (u.prevViewProjectionMatrix!.value as Matrix4).copy(this._prevViewProj);
    u.blend!.value = this.blend;
    u.historyValid!.value = this.historyValid ? 1 : 0;

    renderer.setRenderTarget(historyWrite);
    this.fsQuad.material = this.resolveMaterial;
    this.fsQuad.render(renderer);

    this.copyMaterial.uniforms.tDiffuse!.value = historyWrite.texture;
    this.fsQuad.material = this.copyMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
    renderer.setRenderTarget(prevTarget);

    // Bookkeeping for next frame: the (unjittered) view-projection matrix just used, and swap the
    // history ping-pong index.
    this._prevViewProj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.historyIndex = 1 - this.historyIndex;
    this.historyValid = true;
    this.frameIndex++;
  }

  override dispose(): void {
    this.sceneTarget.dispose();
    for (const t of this.historyTargets) t.dispose();
    this.resolveMaterial.dispose();
    this.copyMaterial.dispose();
    this.fsQuad.dispose();
  }
}
