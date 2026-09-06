/**
 * Central registry of scene materials so that global rendering features (cascaded shadow maps,
 * custom shader patches) can be (re)applied whenever the quality settings change.
 *
 * three.js' CSM helper overwrites `material.onBeforeCompile`; this registry chains the CSM hook
 * with our own patches and keeps `customProgramCacheKey` unique per patch so the program cache
 * never hands a patched material an unpatched program (or vice versa).
 */
import type { Material, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';

export type ShaderPatch = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => void;

interface Entry {
  patch: ShaderPatch | null;
  key: string;
}

type Hook = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => void;

let csmGeneration = 0;

export class MaterialRegistry {
  private readonly entries = new Map<Material, Entry>();
  private csm: CSM | null = null;
  /**
   * Incremented on every setCSM(). Included in the program cache key so a material never
   * reuses a program (and its uniforms object) that belonged to a disposed CSM instance —
   * CSM.dispose() deletes its uniforms from live shader objects, which would otherwise crash
   * WebGLUniforms.upload with `values[name]` undefined.
   */
  private generation = 0;

  /** Register a material; `key` must identify the patch (materials sharing a patch may share it). */
  register<T extends Material>(material: T, opts: { patch?: ShaderPatch; key?: string; csm?: boolean } = {}): T {
    const entry: Entry = { patch: opts.patch ?? null, key: opts.key ?? (opts.patch ? `patch:${this.entries.size}` : 'plain') };
    this.entries.set(material, entry);
    this.apply(material, entry, opts.csm !== false);
    return material;
  }

  unregister(material: Material): void {
    this.entries.delete(material);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Swap the active CSM instance (or null) and re-apply to all registered materials. */
  setCSM(csm: CSM | null): void {
    this.csm = csm;
    this.generation = ++csmGeneration;
    for (const [mat, entry] of this.entries) this.apply(mat, entry, !(mat as Material & { userData: { noCSM?: boolean } }).userData.noCSM);
  }

  private apply(material: Material, entry: Entry, useCSM: boolean): void {
    const defines = (material.defines ??= {});
    delete defines['USE_CSM'];
    delete defines['CSM_CASCADES'];
    delete defines['CSM_FADE'];
    let csmHook: Hook | null = null;
    if (this.csm && useCSM) {
      this.csm.setupMaterial(material);
      csmHook = material.onBeforeCompile as Hook;
    } else {
      (material as Material & { userData: { noCSM?: boolean } }).userData.noCSM = !useCSM;
    }
    const patch = entry.patch;
    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {
      if (csmHook) csmHook.call(material, shader, renderer);
      if (patch) patch(shader, renderer);
    };
    const csmKey = this.csm && useCSM ? `csm${this.csm.cascades}${this.csm.fade ? 'f' : ''}g${this.generation}` : `nocsm-g${this.generation}`;
    material.customProgramCacheKey = () => `${entry.key}|${csmKey}`;
    material.needsUpdate = true;
  }
}
