/**
 * Turns CityData into renderable three.js objects.
 *
 * Scalability techniques:
 *  - One InstancedMesh per (chunk, facade style): thousands of buildings in tens of draw calls.
 *  - Per-instance UV scaling / offsets (custom vertex attributes) so a single tiling facade
 *    texture yields whole windows/floors for every building size, with varied lit patterns.
 *  - Per-chunk LOD: full PBR up to `drawDistance`, flat-shaded impostor material out to
 *    `farDistance`, nothing beyond. Frustum culling per chunk via bounding spheres.
 *  - Roads / sidewalks / props merged per chunk (or city-wide) into single geometries.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LOD,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { QualitySettings } from '../core/Quality';
import type { MaterialRegistry } from '../render/MaterialRegistry';
import {
  FACADE_STYLES,
  createAsphaltMaps,
  createConcreteMap,
  createFacadeMaps,
  createGlowSprite,
  createGrassMap,
  createRoadMaps,
  type FacadeMaps,
} from '../render/Textures';
import { Random } from './Random';
import { FACADE_STYLE_COUNT, blockPitch, laneOffsets, lampHeadPosition, type Building, type ChunkInfo, type CityData } from './CityGenerator';

export interface CityView {
  root: Group;
  /** Materials whose emissive intensity follows the time of day. */
  setNightFactor(f: number): void;
  /** Number of chunks currently within drawDistance (for diagnostics). */
  visibleChunks(cameraPosition: Vector3): number;
  dispose(): void;
  stats: { buildings: number; chunks: number; instancedMeshes: number };
}

interface FacadeMaterialSet {
  near: MeshStandardMaterial;
  far: MeshLambertMaterial;
  maps: FacadeMaps;
}

const FACADE_PATCH_KEY = 'gta7/facade-uv';

/** Vertex-shader patch: per-instance UV scale/offset using custom instanced attributes. */
function facadePatch(shader: { vertexShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
attribute vec3 aUvScale;
attribute vec2 aUvOffset;`,
    )
    .replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
{
  float uScale = abs( normal.x ) > 0.5 ? aUvScale.y : aUvScale.x;
  vec2 fuv = vec2( uv.x * uScale, uv.y * aUvScale.z ) + aUvOffset;
  #ifdef USE_MAP
    vMapUv = fuv;
  #endif
  #ifdef USE_EMISSIVEMAP
    vEmissiveMapUv = fuv;
  #endif
  #ifdef USE_ROUGHNESSMAP
    vRoughnessMapUv = fuv;
  #endif
}`,
    );
}

/**
 * Unit building shell: 4 side faces (group 0) and a roof (group 1), spanning y 0..1.
 * Side UVs: u along the face width, v along height.
 */
export function createBuildingGeometry(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const quad = (p: [number, number, number][], n: [number, number, number]) => {
    const base = positions.length / 3;
    for (const v of p) positions.push(v[0], v[1], v[2]);
    for (let i = 0; i < 4; i++) normals.push(n[0], n[1], n[2]);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // +Z face (front): x from -0.5..0.5
  quad([[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]], [0, 0, 1]);
  // -Z face
  quad([[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]], [0, 0, -1]);
  // +X face: z from 0.5..-0.5
  quad([[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]], [1, 0, 0]);
  // -X face
  quad([[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5]], [-1, 0, 0]);
  const sideIndexCount = indices.length;
  // roof (+Y)
  quad([[-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]], [0, 1, 0]);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.addGroup(0, sideIndexCount, 0);
  g.addGroup(sideIndexCount, indices.length - sideIndexCount, 1);
  return g;
}

/** Share vertex buffers of `base` in a new geometry so per-mesh instanced attributes can be added. */
function shareGeometry(base: BufferGeometry): BufferGeometry {
  const g = new BufferGeometry();
  for (const name of Object.keys(base.attributes)) g.setAttribute(name, base.getAttribute(name));
  if (base.index) g.setIndex(base.index);
  for (const grp of base.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  g.boundingBox = base.boundingBox;
  g.boundingSphere = base.boundingSphere;
  return g;
}

/** Scale BoxGeometry UVs so a texture repeats every `metres` on each face. */
function boxWithMetricUVs(w: number, h: number, d: number, metres: number): BoxGeometry {
  const g = new BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as BufferAttribute;
  // face order: px, nx, py, ny, pz, nz — 4 vertices each
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [du, dv] = dims[f]!;
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * du) / metres, (uv.getY(i) * dv) / metres);
    }
  }
  uv.needsUpdate = true;
  return g;
}

function flatQuad(x0: number, z0: number, x1: number, z1: number, y: number, uAlong: 'x' | 'z', uScale: number, vScale: number): BufferGeometry {
  // A horizontal quad facing +Y. u runs across the strip width, v along its length.
  const g = new BufferGeometry();
  const pos = [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1];
  const nrm = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const w = x1 - x0;
  const d = z1 - z0;
  let uv: number[];
  if (uAlong === 'x') {
    // width across X, length along Z
    uv = [0, 0, uScale * w, 0, uScale * w, vScale * d, 0, vScale * d];
  } else {
    // width across Z, length along X
    uv = [0, 0, 0, vScale * w, uScale * d, vScale * w, uScale * d, 0];
  }
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

export function buildCity(city: CityData, quality: QualitySettings, registry: MaterialRegistry, maxAnisotropy: number): CityView {
  const root = new Group();
  root.name = 'city';
  const p = city.params;
  const aniso = Math.min(quality.anisotropy, Math.max(1, maxAnisotropy));
  const texSize = quality.preset === 'low' ? 256 : quality.preset === 'medium' ? 512 : 1024;
  const disposables: { dispose(): void }[] = [];
  const nightMaterials: { mat: MeshStandardMaterial; day: number; night: number }[] = [];
  /** Same idea as `nightMaterials` but for unlit additive materials driven by opacity instead of
   *  `emissiveIntensity` (the low-preset light-pool decals below). */
  const nightOpacityMaterials: { mat: Material & { opacity: number }; day: number; night: number }[] = [];
  let instancedMeshes = 0;

  // Cheap "streets look lit" substitute for real PointLights (`render/LocalLights.ts`) on the low
  // preset, where `quality.maxLocalLights === 0`: a flat additive quad with a radial-gradient
  // texture on the ground under each lamp head, faded in at night. Built once and shared (as an
  // InstancedMesh per chunk, like the lamp posts themselves) so it costs one draw call per chunk.
  const lightPoolDecals = quality.maxLocalLights === 0;
  const poolQuadGeo = lightPoolDecals ? flatQuad(-0.5, -0.5, 0.5, 0.5, 0, 'x', 1, 1) : null;
  const poolTex = lightPoolDecals ? createGlowSprite(32) : null;
  const poolMat = lightPoolDecals
    ? new MeshBasicMaterial({ map: poolTex, color: 0xffb066, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending })
    : null;
  if (poolMat) {
    registry.register(poolMat, { csm: false });
    nightOpacityMaterials.push({ mat: poolMat, day: 0, night: 0.6 });
    disposables.push(poolMat);
  }
  if (poolTex) disposables.push(poolTex);
  if (poolQuadGeo) disposables.push(poolQuadGeo);
  /** Diameter (m) of one lamp's ground light pool. */
  const LIGHT_POOL_SIZE = 7;
  /** Just above the sidewalk surface (built at y=0.15 below) to avoid z-fighting. */
  const LIGHT_POOL_Y = 0.155;

  // --- materials ------------------------------------------------------------
  const facadeSets: FacadeMaterialSet[] = [];
  for (let s = 0; s < FACADE_STYLE_COUNT; s++) {
    const maps = createFacadeMaps(s, texSize, aniso, p.seed);
    const style = FACADE_STYLES[s]!;
    const near = new MeshStandardMaterial({
      map: maps.map,
      emissiveMap: maps.emissiveMap,
      emissive: new Color(0xffffff),
      emissiveIntensity: 0,
      roughnessMap: maps.roughnessMap,
      roughness: 1,
      metalness: s === 0 ? 0.35 : 0.05,
      envMapIntensity: quality.envReflections ? 0.8 : 0,
    });
    registry.register(near, { patch: facadePatch, key: FACADE_PATCH_KEY });
    const far = new MeshLambertMaterial({
      color: new Color(style.wall[0] / 255, style.wall[1] / 255, style.wall[2] / 255).multiplyScalar(0.9),
    });
    registry.register(far, { csm: false });
    nightMaterials.push({ mat: near, day: 0, night: 2.2 });
    facadeSets.push({ near, far, maps });
    disposables.push(maps.map, maps.emissiveMap, maps.roughnessMap, near, far);
  }
  const roofMat = registry.register(new MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.95, metalness: 0.0 }));
  const roofFarMat = registry.register(new MeshLambertMaterial({ color: 0x33333a }), { csm: false });
  disposables.push(roofMat, roofFarMat);

  const roadMaps = createRoadMaps(texSize, aniso, laneOffsets(p).length, p.seed + 1);
  const asphaltMaps = createAsphaltMaps(texSize / 2, aniso, p.seed + 2);
  const concrete = createConcreteMap(texSize / 2, aniso, p.seed + 3);
  const grass = createGrassMap(texSize / 2, aniso, p.seed + 4);
  disposables.push(roadMaps.map, roadMaps.normalMap, roadMaps.roughnessMap, asphaltMaps.map, asphaltMaps.normalMap, asphaltMaps.roughnessMap, concrete.map, concrete.normalMap, grass);

  const roadMat = registry.register(
    new MeshStandardMaterial({ map: roadMaps.map, normalMap: roadMaps.normalMap, roughnessMap: roadMaps.roughnessMap, roughness: 1, metalness: 0, envMapIntensity: quality.envReflections ? 0.5 : 0 }),
  );
  const asphaltMat = registry.register(
    new MeshStandardMaterial({ map: asphaltMaps.map, normalMap: asphaltMaps.normalMap, roughnessMap: asphaltMaps.roughnessMap, roughness: 1, metalness: 0, envMapIntensity: quality.envReflections ? 0.5 : 0 }),
  );
  const concreteMat = registry.register(new MeshStandardMaterial({ map: concrete.map, normalMap: concrete.normalMap, roughness: 0.9, metalness: 0 }));
  const grassMat = registry.register(new MeshStandardMaterial({ map: grass, roughness: 1, metalness: 0 }));
  const lampMetal = registry.register(new MeshStandardMaterial({ color: 0x55585c, roughness: 0.5, metalness: 0.8 }));
  const lampHead = registry.register(new MeshStandardMaterial({ color: 0xfff2d0, emissive: new Color(0xffd28a), emissiveIntensity: 0, roughness: 0.4 }));
  nightMaterials.push({ mat: lampHead, day: 0, night: 6 });
  const bark = registry.register(new MeshStandardMaterial({ color: 0x5a3f2a, roughness: 0.95 }));
  const leaves = registry.register(new MeshStandardMaterial({ color: 0x2f6b2a, roughness: 0.9, side: DoubleSide }));
  disposables.push(roadMat, asphaltMat, concreteMat, grassMat, lampMetal, lampHead, bark, leaves);

  // --- shared geometries -----------------------------------------------------
  const buildingGeo = createBuildingGeometry();
  buildingGeo.computeBoundingSphere();
  const crownGeo = new BoxGeometry(1, 1, 1);
  crownGeo.translate(0, 0.5, 0);
  const lampGeo = mergeGeometries(
    [
      new CylinderGeometry(0.07, 0.1, 6, 8).translate(0, 3, 0),
      new BoxGeometry(0.1, 0.1, 1.8).translate(0, 5.95, 0.9),
      new BoxGeometry(0.55, 0.16, 0.35).translate(0, 5.85, 1.7),
    ],
    true,
  );
  const treeGeo = mergeGeometries(
    [new CylinderGeometry(0.15, 0.22, 2.2, 6).translate(0, 1.1, 0), new ConeGeometry(1.7, 3.8, 7).translate(0, 3.9, 0)],
    true,
  );
  disposables.push(buildingGeo, crownGeo, lampGeo, treeGeo);

  // --- per-chunk content ------------------------------------------------------
  const chunkBuildings = new Map<string, Building[]>();
  for (const b of city.buildings) {
    let list = chunkBuildings.get(b.chunkKey);
    if (!list) chunkBuildings.set(b.chunkKey, (list = []));
    list.push(b);
  }
  const chunkLamps = new Map<string, typeof city.lamps>();
  for (const l of city.lamps) {
    let list = chunkLamps.get(l.chunkKey);
    if (!list) chunkLamps.set(l.chunkKey, (list = []));
    list.push(l);
  }
  const chunkTrees = new Map<string, typeof city.trees>();
  for (const t of city.trees) {
    let list = chunkTrees.get(t.chunkKey);
    if (!list) chunkTrees.set(t.chunkKey, (list = []));
    list.push(t);
  }

  const rng = new Random(p.seed ^ 0x51ed);
  const m = new Matrix4();
  const q = new Quaternion();
  const pos = new Vector3();
  const scl = new Vector3();
  const color = new Color();
  const lods: LOD[] = [];

  const propStride = quality.propDensity >= 1 ? 1 : Math.max(1, Math.round(1 / Math.max(0.05, quality.propDensity)));

  for (const chunk of city.chunks) {
    const near = new Group();
    const far = new Group();
    near.name = `chunk:${chunk.key}:near`;
    far.name = `chunk:${chunk.key}:far`;

    // buildings grouped by style
    const list = chunkBuildings.get(chunk.key) ?? [];
    const byStyle = new Map<number, Building[]>();
    for (const b of list) {
      let arr = byStyle.get(b.style);
      if (!arr) byStyle.set(b.style, (arr = []));
      arr.push(b);
    }
    const crowned: Building[] = list.filter((b) => b.crown);
    for (const [style, bs] of byStyle) {
      const set = facadeSets[style]!;
      const geo = shareGeometry(buildingGeo);
      const uvScale = new Float32Array(bs.length * 3);
      const uvOffset = new Float32Array(bs.length * 2);
      const windowPitch = set.maps.tileWidth / set.maps.windowsPerTile;
      const floorPitch = set.maps.tileHeight / set.maps.floorsPerTile;
      const mesh = new InstancedMesh(geo, [set.near, roofMat], bs.length);
      const farMesh = new InstancedMesh(shareGeometry(buildingGeo), [set.far, roofFarMat], bs.length);
      bs.forEach((b, i) => {
        pos.set(b.x - chunk.cx, 0, b.z - chunk.cz);
        scl.set(b.w, b.h, b.d);
        m.compose(pos, q.identity(), scl);
        mesh.setMatrixAt(i, m);
        farMesh.setMatrixAt(i, m);
        const tint = 0.82 + b.tint * 0.3;
        color.setRGB(tint, tint, tint);
        mesh.setColorAt(i, color);
        farMesh.setColorAt(i, color);
        // Whole windows across each face and whole floors up the facade.
        const winX = Math.max(1, Math.round(b.w / windowPitch));
        const winZ = Math.max(1, Math.round(b.d / windowPitch));
        const floors = Math.max(1, Math.round(b.h / floorPitch));
        uvScale[i * 3] = winX / set.maps.windowsPerTile;
        uvScale[i * 3 + 1] = winZ / set.maps.windowsPerTile;
        uvScale[i * 3 + 2] = floors / set.maps.floorsPerTile;
        uvOffset[i * 2] = rng.int(0, set.maps.windowsPerTile - 1) / set.maps.windowsPerTile;
        uvOffset[i * 2 + 1] = rng.int(0, set.maps.floorsPerTile - 1) / set.maps.floorsPerTile;
      });
      geo.setAttribute('aUvScale', new InstancedBufferAttribute(uvScale, 3));
      geo.setAttribute('aUvOffset', new InstancedBufferAttribute(uvOffset, 2));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      farMesh.computeBoundingSphere();
      farMesh.castShadow = false;
      farMesh.receiveShadow = false;
      near.add(mesh);
      far.add(farMesh);
      instancedMeshes += 2;
    }
    if (crowned.length > 0) {
      const mesh = new InstancedMesh(crownGeo, roofMat, crowned.length);
      crowned.forEach((b, i) => {
        pos.set(b.x - chunk.cx, b.h, b.z - chunk.cz);
        scl.set(b.w * 0.45, Math.max(3, b.h * 0.06), b.d * 0.45);
        m.compose(pos, q.identity(), scl);
        mesh.setMatrixAt(i, m);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      near.add(mesh);
      instancedMeshes++;
    }

    // lamps
    const lamps = (chunkLamps.get(chunk.key) ?? []).filter((_, i) => i % propStride === 0);
    if (lamps.length > 0) {
      const mesh = new InstancedMesh(lampGeo, [lampMetal, lampMetal, lampHead], lamps.length);
      lamps.forEach((l, i) => {
        pos.set(l.x - chunk.cx, 0.15, l.z - chunk.cz);
        q.setFromAxisAngle(new Vector3(0, 1, 0), l.rotY);
        scl.set(1, 1, 1);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
      });
      mesh.castShadow = quality.preset !== 'low';
      mesh.receiveShadow = false;
      mesh.computeBoundingSphere();
      near.add(mesh);
      instancedMeshes++;

      if (poolQuadGeo && poolMat) {
        const pool = new InstancedMesh(poolQuadGeo, poolMat, lamps.length);
        lamps.forEach((l, i) => {
          const head = lampHeadPosition(l);
          pos.set(head.x - chunk.cx, LIGHT_POOL_Y, head.z - chunk.cz);
          scl.set(LIGHT_POOL_SIZE, 1, LIGHT_POOL_SIZE);
          m.compose(pos, q.identity(), scl);
          pool.setMatrixAt(i, m);
        });
        pool.castShadow = false;
        pool.receiveShadow = false;
        pool.computeBoundingSphere();
        near.add(pool);
        instancedMeshes++;
      }
    }
    // trees
    const trees = (chunkTrees.get(chunk.key) ?? []).filter((_, i) => i % propStride === 0);
    if (trees.length > 0) {
      const mesh = new InstancedMesh(treeGeo, [bark, leaves], trees.length);
      trees.forEach((t, i) => {
        pos.set(t.x - chunk.cx, 0.16, t.z - chunk.cz);
        q.setFromAxisAngle(new Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
        scl.set(t.scale, t.scale, t.scale);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      near.add(mesh);
      far.add(mesh.clone());
      instancedMeshes++;
    }

    // sidewalks (ring per block) and park grass, merged per chunk
    const walkGeos: BufferGeometry[] = [];
    const grassGeos: BufferGeometry[] = [];
    for (const block of city.blocks) {
      if (block.chunkKey !== chunk.key) continue;
      const s = block.size;
      const sw = p.sidewalkWidth;
      const cx = block.x0 + s / 2 - chunk.cx;
      const cz = block.z0 + s / 2 - chunk.cz;
      const h = 0.15;
      const north = boxWithMetricUVs(s, h, sw, 4).translate(cx, h / 2, block.z0 + sw / 2 - chunk.cz);
      const south = boxWithMetricUVs(s, h, sw, 4).translate(cx, h / 2, block.z0 + s - sw / 2 - chunk.cz);
      const west = boxWithMetricUVs(sw, h, s - 2 * sw, 4).translate(block.x0 + sw / 2 - chunk.cx, h / 2, cz);
      const east = boxWithMetricUVs(sw, h, s - 2 * sw, 4).translate(block.x0 + s - sw / 2 - chunk.cx, h / 2, cz);
      walkGeos.push(north, south, west, east);
      if (block.kind === 'park') {
        const g = flatQuad(block.x0 + sw - chunk.cx, block.z0 + sw - chunk.cz, block.x0 + s - sw - chunk.cx, block.z0 + s - sw - chunk.cz, h + 0.01, 'x', 1 / 6, 1 / 6);
        grassGeos.push(g);
      } else {
        // inner block ground: concrete slab so the ground plane does not show between buildings
        const g = flatQuad(block.x0 + sw - chunk.cx, block.z0 + sw - chunk.cz, block.x0 + s - sw - chunk.cx, block.z0 + s - sw - chunk.cz, h + 0.005, 'x', 1 / 4, 1 / 4);
        walkGeos.push(g);
      }
    }
    if (walkGeos.length > 0) {
      const merged = mergeGeometries(walkGeos, false);
      for (const g of walkGeos) g.dispose();
      const mesh = new Mesh(merged, concreteMat);
      mesh.receiveShadow = true;
      near.add(mesh);
      far.add(mesh.clone());
      disposables.push(merged);
    }
    if (grassGeos.length > 0) {
      const merged = mergeGeometries(grassGeos, false);
      for (const g of grassGeos) g.dispose();
      const mesh = new Mesh(merged, grassMat);
      mesh.receiveShadow = true;
      near.add(mesh);
      far.add(mesh.clone());
      disposables.push(merged);
    }

    const lod = new LOD();
    lod.position.set(chunk.cx, 0, chunk.cz);
    lod.addLevel(near, 0);
    lod.addLevel(far, quality.drawDistance);
    lod.addLevel(new Object3D(), quality.farDistance);
    lod.name = `chunk:${chunk.key}`;
    root.add(lod);
    lods.push(lod);
  }

  // --- roads (city-wide merged meshes) -----------------------------------------
  const half = p.roadWidth / 2;
  const roadGeos: BufferGeometry[] = [];
  const crossGeos: BufferGeometry[] = [];
  const y = 0.02;
  const vRepeat = 1 / 8; // texture repeats every 8 m along the road
  for (const e of city.roads.edges) {
    const a = city.roads.nodes[e.a]!;
    const b = city.roads.nodes[e.b]!;
    if (e.axis === 'x') {
      roadGeos.push(flatQuad(a.x + half, a.z - half, b.x - half, a.z + half, y, 'z', 1 / p.roadWidth, vRepeat));
    } else {
      roadGeos.push(flatQuad(a.x - half, a.z + half, a.x + half, b.z - half, y, 'x', 1 / p.roadWidth, vRepeat));
    }
  }
  for (const n of city.roads.nodes) {
    crossGeos.push(flatQuad(n.x - half, n.z - half, n.x + half, n.z + half, y, 'x', 1 / 6, 1 / 6));
  }
  const roadMesh = new Mesh(mergeGeometries(roadGeos, false), roadMat);
  const crossMesh = new Mesh(mergeGeometries(crossGeos, false), asphaltMat);
  for (const g of roadGeos) g.dispose();
  for (const g of crossGeos) g.dispose();
  roadMesh.receiveShadow = crossMesh.receiveShadow = true;
  roadMesh.name = 'roads';
  crossMesh.name = 'intersections';
  root.add(roadMesh, crossMesh);
  disposables.push(roadMesh.geometry, crossMesh.geometry);

  // --- ground -------------------------------------------------------------------
  const margin = 600;
  const gw = city.bounds.maxX - city.bounds.minX + margin * 2;
  const gd = city.bounds.maxZ - city.bounds.minZ + margin * 2;
  const groundGeo = new PlaneGeometry(gw, gd, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);
  const guv = groundGeo.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < guv.count; i++) guv.setXY(i, (guv.getX(i) * gw) / 6, (guv.getY(i) * gd) / 6);
  const ground = new Mesh(groundGeo, grassMat);
  ground.position.set((city.bounds.minX + city.bounds.maxX) / 2, 0, (city.bounds.minZ + city.bounds.maxZ) / 2);
  ground.receiveShadow = true;
  ground.name = 'ground';
  root.add(ground);
  disposables.push(groundGeo);

  void blockPitch; // (kept for future road-network helpers)

  const view: CityView = {
    root,
    setNightFactor(f: number) {
      const t = Math.max(0, Math.min(1, f));
      for (const n of nightMaterials) n.mat.emissiveIntensity = n.day + (n.night - n.day) * t;
      for (const n of nightOpacityMaterials) n.mat.opacity = n.day + (n.night - n.day) * t;
    },
    visibleChunks(cameraPosition: Vector3): number {
      let n = 0;
      for (const lod of lods) {
        const dx = lod.position.x - cameraPosition.x;
        const dz = lod.position.z - cameraPosition.z;
        if (Math.hypot(dx, dz) < quality.drawDistance) n++;
      }
      return n;
    },
    dispose() {
      root.removeFromParent();
      for (const d of disposables) d.dispose();
      root.traverse((o) => {
        const mesh = o as Mesh;
        if ((mesh as InstancedMesh).isInstancedMesh) (mesh as InstancedMesh).dispose();
        if (mesh.geometry && !disposables.includes(mesh.geometry)) mesh.geometry.dispose();
      });
      for (const [mat] of [[roofMat], [roofFarMat], [roadMat], [asphaltMat], [concreteMat], [grassMat], [lampMetal], [lampHead], [bark], [leaves]] as [Material][]) registry.unregister(mat);
      if (poolMat) registry.unregister(poolMat);
      for (const s of facadeSets) {
        registry.unregister(s.near);
        registry.unregister(s.far);
      }
    },
    stats: { buildings: city.buildings.length, chunks: city.chunks.length, instancedMeshes },
  };
  return view;
}

export type { Texture };
