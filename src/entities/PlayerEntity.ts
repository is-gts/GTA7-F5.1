/**
 * The on-foot player: a stylised capsule figure driven by the character controller.
 */
import { CapsuleGeometry, Color, Group, Mesh, MeshStandardMaterial, Object3D, SphereGeometry, BoxGeometry, Vector3 } from 'three';
import type { MaterialRegistry } from '../render/MaterialRegistry';
import {
  DEFAULT_CHARACTER_SPEC,
  createCharacterState,
  resolveCharacterOBB,
  resolveCharacterStatic,
  stepCharacter,
  type CharacterInput,
  type CharacterSpec,
  type CharacterState,
} from '../physics/CharacterController';
import type { OBB, StaticColliderGrid } from '../physics/Collision';
import { wrapAngle } from '../physics/VehiclePhysics';

export class PlayerEntity {
  readonly spec: CharacterSpec = { ...DEFAULT_CHARACTER_SPEC };
  readonly state: CharacterState;
  readonly prev: CharacterState;
  readonly object = new Group();
  private readonly legs: Object3D[] = [];
  private readonly arms: Object3D[] = [];
  private readonly torso: Object3D;
  private walkPhase = 0;
  private readonly materials: MeshStandardMaterial[] = [];

  constructor(registry: MaterialRegistry, x = 0, z = 0, heading = 0) {
    this.state = createCharacterState(x, z, heading);
    this.prev = createCharacterState(x, z, heading);
    this.object.name = 'player';
    const skin = registry.register(new MeshStandardMaterial({ color: 0xd9a57a, roughness: 0.8 }));
    const shirt = registry.register(new MeshStandardMaterial({ color: new Color(0x2f6fd6), roughness: 0.85 }));
    const pants = registry.register(new MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.9 }));
    this.materials.push(skin, shirt, pants);

    this.torso = new Group();
    const chest = new Mesh(new CapsuleGeometry(0.22, 0.42, 4, 10), shirt);
    chest.position.y = 1.15;
    const head = new Mesh(new SphereGeometry(0.15, 12, 10), skin);
    head.position.y = 1.62;
    chest.castShadow = head.castShadow = true;
    this.torso.add(chest, head);
    this.object.add(this.torso);
    for (const side of [-1, 1]) {
      const legPivot = new Object3D();
      legPivot.position.set(side * 0.11, 0.85, 0);
      const leg = new Mesh(new BoxGeometry(0.16, 0.85, 0.18), pants);
      leg.position.y = -0.425;
      leg.castShadow = true;
      legPivot.add(leg);
      this.object.add(legPivot);
      this.legs.push(legPivot);
      const armPivot = new Object3D();
      armPivot.position.set(side * 0.3, 1.42, 0);
      const arm = new Mesh(new BoxGeometry(0.11, 0.62, 0.12), shirt);
      arm.position.y = -0.31;
      arm.castShadow = true;
      armPivot.add(arm);
      this.torso.add(armPivot);
      this.arms.push(armPivot);
    }
    this.syncVisual(1);
  }

  get position(): Vector3 {
    return this.object.position;
  }

  step(dt: number, input: CharacterInput, grid: StaticColliderGrid, vehicles: OBB[]): void {
    Object.assign(this.prev, this.state);
    stepCharacter(this.state, this.spec, input, dt);
    resolveCharacterStatic(this.state, this.spec, grid);
    for (const obb of vehicles) resolveCharacterOBB(this.state, this.spec, obb);
    this.walkPhase += dt * (4 + 8 * this.state.moveBlend) * (this.state.moveBlend > 0.02 ? 1 : 0);
  }

  syncVisual(alpha: number): void {
    const a = Math.max(0, Math.min(1, alpha));
    const s = this.state;
    const p = this.prev;
    this.object.position.set(p.x + (s.x - p.x) * a, 0, p.z + (s.z - p.z) * a);
    this.object.rotation.set(0, p.heading + wrapAngle(s.heading - p.heading) * a, 0);
    const swing = Math.sin(this.walkPhase) * 0.6 * s.moveBlend;
    this.legs[0]!.rotation.x = swing;
    this.legs[1]!.rotation.x = -swing;
    this.arms[0]!.rotation.x = -swing * 0.8;
    this.arms[1]!.rotation.x = swing * 0.8;
    this.torso.rotation.x = 0.08 * s.moveBlend;
    this.torso.position.y = Math.abs(Math.sin(this.walkPhase * 2)) * 0.03 * s.moveBlend;
  }

  teleport(x: number, z: number, heading: number): void {
    Object.assign(this.state, createCharacterState(x, z, heading));
    Object.assign(this.prev, this.state);
    this.syncVisual(1);
  }

  dispose(registry: MaterialRegistry): void {
    this.object.removeFromParent();
    this.object.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const m of this.materials) {
      registry.unregister(m);
      m.dispose();
    }
  }
}
