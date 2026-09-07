/**
 * HDR post-processing pipeline built on EffectComposer.
 *
 *   RenderPass / SSAARenderPass / TAAPass (HalfFloat, optional MSAA)
 *     → GTAO or SSAO (optionally at reduced resolution)
 *     → SSRPass (wet-road screen-space reflections, high/ultra only)
 *     → UnrealBloom (threshold 1.0: only HDR highlights bloom)
 *     → OutputPass (tone mapping + sRGB)
 *     → SMAA 1x or FXAA (post-tonemap edge AA, complements/replaces MSAA)
 */
import { HalfFloatType, Vector2, WebGLRenderTarget, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAARenderPass } from 'three/addons/postprocessing/SSAARenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { AAMode, QualitySettings } from '../core/Quality';
import { SSRPass } from './SSRPass';
import { TAAPass } from './TAAPass';

/** AA modes this pipeline implements (drives the settings-menu dropdown, see `Menu.ts`). */
export const AVAILABLE_AA_MODES: readonly AAMode[] = ['none', 'fxaa', 'smaa', 'msaa', 'ssaa', 'taa'];

export interface PipelineInfo {
  aa: QualitySettings['aa'];
  msaaSamples: number;
  ao: QualitySettings['ao'];
  bloom: boolean;
  passes: string[];
  /** Halton sample index (0..sampleCount-1) the TAA pass used for the last-rendered frame; 0 when
   *  `aa !== 'taa'`. Updated every `render()` call — see `TAAPass.jitterIndex`. */
  taaJitterIndex: number;
}

export class PostPipeline {
  readonly composer: EffectComposer;
  readonly info: PipelineInfo;
  private readonly passes: Pass[] = [];
  private readonly gtao: GTAOPass | null = null;
  private readonly ssao: SSAOPass | null = null;
  private readonly ssr: SSRPass | null = null;
  private readonly bloom: UnrealBloomPass | null = null;
  private readonly taa: TAAPass | null = null;
  private readonly aoScale: number;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    q: QualitySettings,
    width: number,
    height: number,
  ) {
    const pr = renderer.getPixelRatio();
    const target = new WebGLRenderTarget(Math.max(1, Math.floor(width * pr)), Math.max(1, Math.floor(height * pr)), {
      type: HalfFloatType,
      samples: q.aa === 'msaa' ? q.msaaSamples : 0,
      depthBuffer: true,
      stencilBuffer: false,
    });
    target.texture.name = 'GTA7.hdr';
    this.composer = new EffectComposer(renderer, target);
    this.aoScale = q.aoScale;

    // 1. scene colour
    if (q.aa === 'ssaa') {
      const ssaa = new SSAARenderPass(scene, camera);
      ssaa.sampleLevel = 2; // 4 jittered samples
      ssaa.unbiased = true;
      this.add(ssaa, 'ssaa');
    } else if (q.aa === 'taa') {
      const taa = new TAAPass(scene, camera, Math.max(1, Math.floor(width * pr)), Math.max(1, Math.floor(height * pr)), {
        blend: q.taaBlend,
      });
      this.taa = taa;
      this.add(taa, 'taa');
    } else {
      this.add(new RenderPass(scene, camera), 'render');
    }

    // 2. ambient occlusion
    if (q.ao === 'gtao') {
      const aw = Math.max(1, Math.floor(width * pr * q.aoScale));
      const ah = Math.max(1, Math.floor(height * pr * q.aoScale));
      const gtao = new GTAOPass(scene, camera, aw, ah);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 1;
      gtao.updateGtaoMaterial({ radius: 1.2, distanceExponent: 1, thickness: 1, scale: 1.2, samples: q.aoScale < 1 ? 8 : 16, distanceFallOff: 1, screenSpaceRadius: false });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 8 });
      this.gtao = gtao;
      this.add(gtao, 'gtao');
    } else if (q.ao === 'ssao') {
      const aw = Math.max(1, Math.floor(width * pr * q.aoScale));
      const ah = Math.max(1, Math.floor(height * pr * q.aoScale));
      const ssao = new SSAOPass(scene, camera, aw, ah, 16);
      ssao.kernelRadius = 6;
      ssao.minDistance = 0.002;
      ssao.maxDistance = 0.08;
      ssao.output = SSAOPass.OUTPUT.Default;
      this.ssao = ssao;
      this.add(ssao, 'ssao');
    }

    // 3. screen-space reflections for wet roads (high/ultra only) — composited before bloom so a
    //    bright reflected window/lamp can still bloom same as the real thing.
    if (q.ssr) {
      const ssr = new SSRPass(scene, camera, Math.floor(width * pr), Math.floor(height * pr), { scale: q.ssrScale });
      this.ssr = ssr;
      this.add(ssr, 'ssr');
    }

    // 4. bloom on HDR highlights only
    if (q.bloom) {
      const bloom = new UnrealBloomPass(new Vector2(Math.floor(width * pr), Math.floor(height * pr)), 0.35, 0.5, 1.0);
      this.bloom = bloom;
      this.add(bloom, 'bloom');
    }

    // 5. tone mapping + colour space
    this.add(new OutputPass(), 'output');

    // 6. post-tonemap edge anti-aliasing
    if (q.aa === 'smaa') this.add(new SMAAPass(), 'smaa');
    else if (q.aa === 'fxaa') this.add(new FXAAPass(), 'fxaa');

    this.info = {
      aa: q.aa,
      msaaSamples: q.aa === 'msaa' ? q.msaaSamples : 0,
      ao: q.ao,
      bloom: q.bloom,
      passes: this.passes.map((p) => (p as Pass & { __name?: string }).__name ?? p.constructor.name),
      taaJitterIndex: 0,
    };
    this.setSize(width, height);
  }

  private add(pass: Pass, name: string): void {
    (pass as Pass & { __name?: string }).__name = name;
    this.passes.push(pass);
    this.composer.addPass(pass);
  }

  /** CSS-pixel size; the composer applies the renderer's pixel ratio. */
  setSize(width: number, height: number): void {
    this.composer.setPixelRatio(this.composer.renderer.getPixelRatio());
    this.composer.setSize(width, height);
    const pr = this.composer.renderer.getPixelRatio();
    // Keep AO at its reduced resolution (composer.setSize resets passes to full size).
    const aw = Math.max(1, Math.floor(width * pr * this.aoScale));
    const ah = Math.max(1, Math.floor(height * pr * this.aoScale));
    this.gtao?.setSize(aw, ah);
    this.ssao?.setSize(aw, ah);
  }

  render(deltaTime: number): void {
    this.composer.render(deltaTime);
    if (this.taa) this.info.taaJitterIndex = this.taa.jitterIndex;
  }

  setBloomStrength(strength: number): void {
    if (this.bloom) this.bloom.strength = strength;
  }

  /** Road wetness (0..1) driving SSR reflectivity; a no-op when `q.ssr` is false (no pass built). */
  setWetness(w: number): void {
    this.ssr?.setWetness(w);
  }

  dispose(): void {
    for (const p of this.passes) p.dispose();
    this.composer.dispose();
  }
}
