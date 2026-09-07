/**
 * World markers for missions (Task 09): glowing translucent cylinders — additive, emissive-looking,
 * unlit (so no shadow interaction and no lighting cost) — at the start of each available mission and
 * at the current checkpoint of the active one. A small fixed pool of `Mesh`es (like
 * `render/LocalLights.ts`'s point-light pool), repositioned in place each frame from a caller-owned
 * list, so a changing number of markers costs no per-frame allocation beyond growing the pool once.
 */
import { CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, AdditiveBlending } from 'three';
import type { MaterialRegistry } from './MaterialRegistry';

export type MarkerKind = 'start' | 'checkpoint';

export interface MarkerInput {
  x: number;
  z: number;
  kind: MarkerKind;
}

/** Marker column height/radius (m) — tall enough to read from a distance, like GTA's own. */
const MARKER_HEIGHT = 12;
const MARKER_RADIUS = 2.3;
/** Gold for an available mission's start marker, magenta for the active checkpoint — deliberately
 *  not the cyan the player arrow and the police dots already use on the minimap (`ui/Minimap.ts`
 *  mirrors these two colours), so "where I can start something" and "where I must go now" never
 *  read as the same thing. */
const START_COLOR = 0xffd24a;
const CHECKPOINT_COLOR = 0xff5ce6;
/** Slow scale pulse so the column reads as "alive" without being distracting or non-deterministic
 *  (driven by `simTime`, not wall clock — see `Game.render`'s `Rain.update` call for the same
 *  reasoning: headless `simulate()`/screenshot sequences must stay reproducible). */
const PULSE_SPEED = 2.0;
const PULSE_AMOUNT = 0.12;

/** Radial segments, clamped to something that is still a recognisable column (and never a degenerate
 *  0/1/2-sided geometry) whatever a hand-edited settings profile asks for. */
function clampSegments(segments: number): number {
  return Number.isFinite(segments) ? Math.max(3, Math.min(32, Math.round(segments))) : 8;
}

function buildGeometry(segments: number): CylinderGeometry {
  const g = new CylinderGeometry(MARKER_RADIUS, MARKER_RADIUS * 1.2, MARKER_HEIGHT, segments, 1, true);
  g.translate(0, MARKER_HEIGHT / 2, 0);
  return g;
}

export class MissionMarkers {
  readonly root = new Group();
  private geo: CylinderGeometry;
  private readonly startMat: MeshBasicMaterial;
  private readonly checkpointMat: MeshBasicMaterial;
  private readonly pool: Mesh[] = [];

  /** Radial segments the current `geo` was built with (`QualitySettings.markerSegments`). */
  private segments: number;

  constructor(
    private readonly registry: MaterialRegistry,
    segments: number,
  ) {
    this.segments = clampSegments(segments);
    this.geo = buildGeometry(this.segments);
    this.startMat = registry.register(
      new MeshBasicMaterial({ color: START_COLOR, transparent: true, opacity: 0.42, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
      { csm: false },
    );
    this.checkpointMat = registry.register(
      new MeshBasicMaterial({ color: CHECKPOINT_COLOR, transparent: true, opacity: 0.48, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
      { csm: false },
    );
  }

  /** Rebuild the (quality-gated) geometry for `segments` sides, disposing the old one first —
   *  called from `Game.applyQuality` alongside every other GPU-resource rebuild. A no-op when the
   *  new preset asks for the same tessellation, so switching e.g. high -> ultra -> high does not
   *  churn buffers for nothing. */
  setQuality(segments: number): void {
    const next = clampSegments(segments);
    if (next === this.segments) return;
    const fresh = buildGeometry(next);
    for (const m of this.pool) m.geometry = fresh;
    this.geo.dispose();
    this.geo = fresh;
    this.segments = next;
  }

  /**
   * Reposition the pool onto `markers` (grown, never shrunk, like `LocalLights`'s light pool) and
   * hide any surplus slots. `simTime` drives the pulse — deterministic simulation time, not
   * `performance.now()`.
   */
  update(markers: readonly MarkerInput[], simTime: number): void {
    while (this.pool.length < markers.length) {
      const mesh = new Mesh(this.geo, this.startMat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = true;
      this.root.add(mesh);
      this.pool.push(mesh);
    }
    const pulse = 1 + PULSE_AMOUNT * Math.sin(simTime * PULSE_SPEED);
    for (let i = 0; i < this.pool.length; i++) {
      const mesh = this.pool[i]!;
      const input = markers[i];
      if (!input) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(input.x, 0, input.z);
      mesh.scale.set(pulse, 1, pulse);
      mesh.material = input.kind === 'start' ? this.startMat : this.checkpointMat;
    }
  }

  dispose(): void {
    this.root.clear();
    this.pool.length = 0;
    this.geo.dispose();
    this.startMat.dispose();
    this.checkpointMat.dispose();
    this.registry.unregister(this.startMat);
    this.registry.unregister(this.checkpointMat);
  }
}
