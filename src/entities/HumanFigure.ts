/**
 * Shared low-poly humanoid figure construction (dimensions + the animated rig builder), used by
 * `PlayerEntity` and reused by the pedestrian pool (`src/ai/Pedestrians.ts`) so the two always
 * look consistent. Pedestrians are pooled far more densely than the single player, so they use a
 * single merged, static (non-animated) geometry built from the same dimensions instead of the
 * animated rig below — see `buildPedestrianGeometry` in Pedestrians.ts.
 */
import { CapsuleGeometry, Group, Mesh, type Material, Object3D, SphereGeometry, BoxGeometry } from 'three';

/** All the numbers that describe the figure's proportions, shared by every consumer. */
export const HUMAN_FIGURE = {
  chestRadius: 0.22,
  chestLength: 0.42,
  chestY: 1.15,
  headRadius: 0.15,
  headY: 1.62,
  legSize: [0.16, 0.85, 0.18] as const,
  legPivotY: 0.85,
  legOffsetX: 0.11,
  legLocalY: -0.425,
  armSize: [0.11, 0.62, 0.12] as const,
  armPivotY: 1.42,
  armOffsetX: 0.3,
  armLocalY: -0.31,
};

export interface HumanFigureMaterials {
  skin: Material;
  shirt: Material;
  pants: Material;
}

export interface HumanFigureRig {
  object: Group;
  torso: Object3D;
  legs: [Object3D, Object3D];
  arms: [Object3D, Object3D];
}

/** Build the animated rig (independent leg/arm pivots for walk-cycle animation), used by the player. */
export function buildHumanFigureRig(materials: HumanFigureMaterials): HumanFigureRig {
  const f = HUMAN_FIGURE;
  const object = new Group();
  const torso = new Group();
  const chest = new Mesh(new CapsuleGeometry(f.chestRadius, f.chestLength, 4, 10), materials.shirt);
  chest.position.y = f.chestY;
  const head = new Mesh(new SphereGeometry(f.headRadius, 12, 10), materials.skin);
  head.position.y = f.headY;
  chest.castShadow = head.castShadow = true;
  torso.add(chest, head);
  object.add(torso);
  const legs: Object3D[] = [];
  const arms: Object3D[] = [];
  for (const side of [-1, 1]) {
    const legPivot = new Object3D();
    legPivot.position.set(side * f.legOffsetX, f.legPivotY, 0);
    const leg = new Mesh(new BoxGeometry(...f.legSize), materials.pants);
    leg.position.y = f.legLocalY;
    leg.castShadow = true;
    legPivot.add(leg);
    object.add(legPivot);
    legs.push(legPivot);
    const armPivot = new Object3D();
    armPivot.position.set(side * f.armOffsetX, f.armPivotY, 0);
    const arm = new Mesh(new BoxGeometry(...f.armSize), materials.shirt);
    arm.position.y = f.armLocalY;
    arm.castShadow = true;
    armPivot.add(arm);
    torso.add(armPivot);
    arms.push(armPivot);
  }
  return { object, torso, legs: legs as [Object3D, Object3D], arms: arms as [Object3D, Object3D] };
}
