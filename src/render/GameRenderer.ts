/**
 * Owns the WebGLRenderer, the post pipeline and resolution scaling.
 */
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  NeutralToneMapping,
  PCFShadowMap,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import { AdaptiveResolution, type DeviceInfo, type QualitySettings } from '../core/Quality';
import { PostPipeline } from './PostPipeline';

const _size = new Vector2();

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  renderScale: number;
  pixelRatio: number;
  width: number;
  height: number;
}

export class GameRenderer {
  readonly renderer: WebGLRenderer;
  pipeline: PostPipeline | null = null;
  adaptive: AdaptiveResolution | null = null;
  private quality: QualitySettings;
  private cssWidth = 1;
  private cssHeight = 1;
  private basePixelRatio = 1;
  private renderScale = 1;
  private scene: Scene | null = null;
  private camera: PerspectiveCamera | null = null;

  constructor(readonly canvas: HTMLCanvasElement, quality: QualitySettings, devicePixelRatio = 1) {
    this.quality = quality;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false, // AA is handled by the post pipeline / MSAA render target
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Count draw calls across the whole post-processing frame, not just the last pass.
    this.renderer.info.autoReset = false;
    this.basePixelRatio = Math.min(devicePixelRatio, quality.maxPixelRatio);
    this.applyRendererSettings(quality);
  }

  get deviceInfo(): DeviceInfo {
    const gl = this.renderer.getContext();
    let gpuRenderer = '';
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpuRenderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    } catch {
      /* ignore */
    }
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    return {
      gpuRenderer,
      deviceMemoryGB: (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory,
      hardwareConcurrency: nav?.hardwareConcurrency,
      isMobile: nav ? /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) : false,
      devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
      maxTextureSize: this.renderer.capabilities.maxTextureSize,
    };
  }

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  get currentRenderScale(): number {
    return this.renderScale;
  }

  get settings(): QualitySettings {
    return this.quality;
  }

  private applyRendererSettings(q: QualitySettings): void {
    const r = this.renderer;
    r.toneMapping = q.toneMapping === 'agx' ? AgXToneMapping : q.toneMapping === 'neutral' ? NeutralToneMapping : ACESFilmicToneMapping;
    r.toneMappingExposure = q.toneMapping === 'agx' ? 1.0 : 0.85;
    r.shadowMap.enabled = q.shadows !== 'none';
    // r185: PCFShadowMap is a Vogel-disk soft PCF whose width is `light.shadow.radius` (set in Lighting);
    // PCFSoftShadowMap is deprecated.
    r.shadowMap.type = PCFShadowMap;
    r.shadowMap.autoUpdate = true;
  }

  /** Build (or rebuild) the post pipeline for the given scene/camera and quality. */
  applyQuality(q: QualitySettings, scene: Scene, camera: PerspectiveCamera, devicePixelRatio = 1): void {
    this.quality = q;
    this.scene = scene;
    this.camera = camera;
    this.basePixelRatio = Math.min(devicePixelRatio, q.maxPixelRatio);
    this.renderScale = q.renderScale;
    this.adaptive = q.adaptiveResolution
      ? new AdaptiveResolution({ initialScale: q.renderScale, minScale: q.minRenderScale, maxScale: Math.max(q.renderScale, q.minRenderScale), targetFps: q.targetFps })
      : null;
    this.applyRendererSettings(q);
    this.pipeline?.dispose();
    this.pipeline = null;
    // Shadow maps must be re-allocated when the type changes.
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setPixelRatio(this.basePixelRatio * this.renderScale);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.pipeline = new PostPipeline(this.renderer, scene, camera, q, this.cssWidth, this.cssHeight);
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.cssWidth = Math.max(1, Math.floor(cssWidth));
    this.cssHeight = Math.max(1, Math.floor(cssHeight));
    this.renderer.setPixelRatio(this.basePixelRatio * this.renderScale);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    if (this.camera) {
      this.camera.aspect = this.cssWidth / this.cssHeight;
      this.camera.updateProjectionMatrix();
    }
    this.pipeline?.setSize(this.cssWidth, this.cssHeight);
  }

  setRenderScale(scale: number): void {
    scale = Math.max(0.25, Math.min(2, scale));
    if (Math.abs(scale - this.renderScale) < 1e-3) return;
    this.renderScale = scale;
    this.resize(this.cssWidth, this.cssHeight);
  }

  /** Render one frame; feeds the adaptive resolution controller with the measured frame time. */
  render(frameDelta: number): void {
    if (!this.pipeline) return;
    this.renderer.info.reset();
    this.pipeline.render(frameDelta);
    if (this.adaptive && this.adaptive.update(frameDelta)) {
      this.setRenderScale(this.adaptive.scale);
    }
  }

  stats(): RenderStats {
    const info = this.renderer.info;
    const size = this.renderer.getDrawingBufferSize(_size);
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      renderScale: this.renderScale,
      pixelRatio: this.renderer.getPixelRatio(),
      width: size.x,
      height: size.y,
    };
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.renderer.dispose();
  }
}
