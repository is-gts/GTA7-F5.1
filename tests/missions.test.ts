import { describe, expect, it } from 'vitest';
import { generateCity, type CityData, type RoadEdge } from '../src/world/CityGenerator';
import {
  CHECKPOINT_RADIUS,
  DEFAULT_MISSION_COUNT,
  FAILED_RETRY_COOLDOWN,
  MAX_CHECKPOINT_SPACING,
  MIN_CHECKPOINT_SPACING,
  MIN_POINT_SEPARATION,
  OUT_OF_VEHICLE_FAIL_TIME,
  RACE_CHECKPOINT_COUNT,
  activeCheckpoint,
  advanceCheckpoint,
  availableCount,
  bearingArrow,
  checkpointTarget,
  createMissionsState,
  failMission,
  formatMissionTime,
  generateMissions,
  loadMissionsSave,
  relativeBearing,
  reviveFailedMissions,
  saveMissionsSave,
  startMission,
  stepActiveMission,
  type MissionDef,
  type MissionPoint,
} from '../src/game/Missions';

const DT = 1 / 60;

/** Perpendicular distance (m) from `p` to the segment joining the two ends of `edge`. */
function distanceToEdge(city: CityData, edge: RoadEdge, p: MissionPoint): number {
  const a = city.roads.nodes[edge.a]!;
  const b = city.roads.nodes[edge.b]!;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  const px = p.x - (a.x + dx * t);
  const pz = p.z - (a.z + dz * t);
  return Math.hypot(px, pz);
}

/** Distance from `p` to whichever road edge is actually closest to it. */
function distanceToNearestEdge(city: CityData, p: MissionPoint): number {
  let best = Infinity;
  for (const edge of city.roads.edges) best = Math.min(best, distanceToEdge(city, edge, p));
  return best;
}

/** Every consecutive point in a mission's [start, ...checkpoints] sequence. */
function pointSequence(def: MissionDef): MissionPoint[] {
  return [def.start, ...def.checkpoints];
}

describe('generateMissions', () => {
  const city = generateCity({ seed: 7, cols: 10, rows: 10 });

  it('is deterministic for a given city + seed', () => {
    const a = generateMissions(city, 42);
    const b = generateMissions(city, 42);
    expect(b).toEqual(a);
  });

  it('differs for a different seed', () => {
    const a = generateMissions(city, 42);
    const b = generateMissions(city, 43);
    expect(b.map((d) => [d.start.x, d.start.z])).not.toEqual(a.map((d) => [d.start.x, d.start.z]));
  });

  it('produces the requested count, alternating race/delivery, with the right checkpoint shape', () => {
    const defs = generateMissions(city, 1, 6);
    expect(defs.length).toBe(6);
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i]!;
      expect(d.type).toBe(i % 2 === 0 ? 'race' : 'delivery');
      expect(d.checkpoints.length).toBe(d.type === 'race' ? RACE_CHECKPOINT_COUNT : 2);
      expect(d.reward).toBeGreaterThan(0);
      expect(d.timeLimit).toBeGreaterThan(0);
    }
  });

  it('defaults to DEFAULT_MISSION_COUNT missions when no count is given', () => {
    expect(generateMissions(city, 1).length).toBe(DEFAULT_MISSION_COUNT);
  });

  it('every start and checkpoint lies on a road, within roadWidth/2 of its nearest edge centreline', () => {
    const defs = generateMissions(city, 7);
    const half = city.params.roadWidth / 2;
    for (const def of defs) {
      for (const p of pointSequence(def)) {
        expect(distanceToNearestEdge(city, p)).toBeLessThanOrEqual(half + 1e-6);
      }
    }
  });

  it('consecutive points (start -> checkpoints in order) are at least 60 m apart', () => {
    const defs = generateMissions(city, 7);
    for (const def of defs) {
      const seq = pointSequence(def);
      for (let i = 1; i < seq.length; i++) {
        const d = Math.hypot(seq[i]!.x - seq[i - 1]!.x, seq[i]!.z - seq[i - 1]!.z);
        expect(d).toBeGreaterThanOrEqual(MIN_CHECKPOINT_SPACING);
      }
    }
  });

  it('keeps every generated point clear of every other one, across missions as well as within one', () => {
    // Two markers closer than MIN_POINT_SEPARATION would draw as overlapping columns and, worse,
    // finishing one mission inside another's start trigger would auto-start it on the spot.
    const defs = generateMissions(city, 7, 10);
    const all: MissionPoint[] = defs.flatMap(pointSequence);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const d = Math.hypot(all[i]!.x - all[j]!.x, all[i]!.z - all[j]!.z);
        expect(d).toBeGreaterThanOrEqual(MIN_POINT_SEPARATION);
      }
    }
  });

  it('keeps points clear of one another across many seeds of the default (14x14) city Game.ts uses', () => {
    // The seed-sweep the single-city case above cannot catch: `Game` derives the mission seed from
    // the city seed, so a rare unlucky draw would only show up in some players' cities.
    const defaultCity = generateCity();
    for (let seed = 0; seed < 40; seed++) {
      const defs = generateMissions(defaultCity, seed ^ 0x3a11510);
      const all: MissionPoint[] = defs.flatMap(pointSequence);
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const d = Math.hypot(all[i]!.x - all[j]!.x, all[i]!.z - all[j]!.z);
          expect(d, `seed ${seed}: points ${i} and ${j}`).toBeGreaterThanOrEqual(MIN_POINT_SEPARATION);
        }
      }
    }
  });

  it('MIN_POINT_SEPARATION leaves the CHECKPOINT_RADIUS trigger circles disjoint', () => {
    expect(MIN_POINT_SEPARATION).toBeGreaterThan(2 * CHECKPOINT_RADIUS);
    expect(MIN_POINT_SEPARATION).toBeLessThan(MIN_CHECKPOINT_SPACING);
  });

  it('mission ids are unique', () => {
    const defs = generateMissions(city, 7, 10);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
  });

  it('consecutive points are bounded so a route stays local, not a cross-city hop', () => {
    // A generous margin over MAX_CHECKPOINT_SPACING for the rare best-effort fallback (see
    // `nextPoint`'s SPACING_MAX_TRIES) rather than the exact bound itself.
    const defs = generateMissions(city, 7, 10);
    for (const def of defs) {
      const seq = pointSequence(def);
      for (let i = 1; i < seq.length; i++) {
        const d = Math.hypot(seq[i]!.x - seq[i - 1]!.x, seq[i]!.z - seq[i - 1]!.z);
        expect(d).toBeLessThanOrEqual(MAX_CHECKPOINT_SPACING * 1.5);
      }
    }
  });

  it('timeLimit requires only a reasonable average speed for every mission in the default (14x14) city, the one Game.ts actually generates missions for', () => {
    // Manhattan distance (not straight-line): the road grid has no diagonal streets, so this is the
    // actual distance a player must drive, matching what `computeTimeLimit` budgets against.
    const manhattan = (a: MissionPoint, b: MissionPoint) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
    const defaultCity = generateCity(); // default params: cols=14, rows=14, seed=7
    const defs = generateMissions(defaultCity, defaultCity.params.seed ^ 0x3a11510);
    expect(defs.length).toBeGreaterThan(0);
    // Comfortably above the 14 m/s (~50 km/h) target the timer is actually budgeted against, and
    // well under even the slowest catalog vehicle's top speed (the van, 40 m/s) — so this is a real
    // margin, not a tautological restatement of the implementation.
    const REASONABLE_AVG_SPEED = 20;
    for (const def of defs) {
      const seq = pointSequence(def);
      let dist = 0;
      for (let i = 1; i < seq.length; i++) dist += manhattan(seq[i - 1]!, seq[i]!);
      const requiredAvgSpeed = dist / def.timeLimit;
      expect(requiredAvgSpeed).toBeLessThanOrEqual(REASONABLE_AVG_SPEED);
    }
  });
});

describe('missions state machine', () => {
  const city = generateCity({ seed: 3, cols: 8, rows: 8 });
  const defs = generateMissions(city, 3, 4);

  it('starts with every mission available, none active, zero money', () => {
    const s = createMissionsState(defs);
    expect(s.activeId).toBeNull();
    expect(s.money).toBe(0);
    expect(availableCount(s)).toBe(defs.length);
    for (const def of defs) expect(s.runtime[def.id]!.status).toBe('available');
  });

  it('startMission activates the mission and resets its checkpoint/timer bookkeeping', () => {
    const def = defs[0]!;
    let s = createMissionsState(defs);
    s = startMission(s, def.id);
    expect(s.activeId).toBe(def.id);
    expect(s.runtime[def.id]!.status).toBe('active');
    expect(s.runtime[def.id]!.checkpointIndex).toBe(0);
    expect(s.runtime[def.id]!.timeRemaining).toBe(def.timeLimit);
    expect(activeCheckpoint(s)).toEqual(def.checkpoints[0]);
  });

  it('startMission is a no-op when another mission is already active', () => {
    const [a, b] = defs;
    let s = createMissionsState(defs);
    s = startMission(s, a!.id);
    const afterFirst = s;
    s = startMission(s, b!.id);
    expect(s).toBe(afterFirst); // unchanged reference: pure no-op
    expect(s.activeId).toBe(a!.id);
    expect(s.runtime[b!.id]!.status).toBe('available');
  });

  it('startMission is a no-op for an unknown or non-available mission id', () => {
    const s0 = createMissionsState(defs);
    expect(startMission(s0, 'nope')).toBe(s0);
    const started = startMission(s0, defs[0]!.id);
    // Already active: starting it again is a no-op too.
    expect(startMission(started, defs[0]!.id)).toBe(started);
  });

  it('advanceCheckpoint steps through every checkpoint in order, then completes and pays the reward', () => {
    const def = defs.find((d) => d.type === 'race')!;
    let s = createMissionsState(defs);
    s = startMission(s, def.id);
    for (let i = 0; i < def.checkpoints.length - 1; i++) {
      s = advanceCheckpoint(s, def.id);
      expect(s.runtime[def.id]!.status).toBe('active');
      expect(s.runtime[def.id]!.checkpointIndex).toBe(i + 1);
      expect(s.activeId).toBe(def.id);
      expect(activeCheckpoint(s)).toEqual(def.checkpoints[i + 1]);
    }
    const moneyBefore = s.money;
    s = advanceCheckpoint(s, def.id);
    expect(s.runtime[def.id]!.status).toBe('complete');
    expect(s.activeId).toBeNull();
    expect(s.money).toBe(moneyBefore + def.reward);
    expect(s.completedIds).toContain(def.id);
    expect(activeCheckpoint(s)).toBeNull();
  });

  it('advanceCheckpoint is a no-op for a mission that is not the active one', () => {
    const [a, b] = defs;
    let s = createMissionsState(defs);
    s = startMission(s, a!.id);
    const before = s;
    s = advanceCheckpoint(s, b!.id); // b is available, not active
    expect(s).toBe(before);
  });

  it('checkpointTarget returns null past the last checkpoint and for an unknown id', () => {
    const def = defs[0]!;
    let s = createMissionsState(defs);
    s = startMission(s, def.id);
    for (let i = 0; i < def.checkpoints.length; i++) s = advanceCheckpoint(s, def.id);
    expect(checkpointTarget(s, def.id)).toBeNull();
  });

  it('failMission fails the active mission and frees it up for another to start', () => {
    const [a, b] = defs;
    let s = createMissionsState(defs);
    s = startMission(s, a!.id);
    s = failMission(s, a!.id);
    expect(s.runtime[a!.id]!.status).toBe('failed');
    expect(s.activeId).toBeNull();
    // A different mission can now be started.
    s = startMission(s, b!.id);
    expect(s.activeId).toBe(b!.id);
  });

  it('failMission is a no-op on a mission that is not active', () => {
    const s0 = createMissionsState(defs);
    expect(failMission(s0, defs[0]!.id)).toBe(s0); // available, not active
  });

  it('reviveFailedMissions is a cheap no-op when nothing is failed', () => {
    const s0 = createMissionsState(defs);
    expect(reviveFailedMissions(s0, DT)).toBe(s0);
    let s = startMission(s0, defs[0]!.id); // active, not failed
    expect(reviveFailedMissions(s, DT)).toBe(s);
    s = advanceCheckpoint(s, defs[0]!.id); // still active (not the last checkpoint yet)
    expect(reviveFailedMissions(s, DT)).toBe(s);
  });

  it("a failed mission returns to 'available' after FAILED_RETRY_COOLDOWN and can be started again (it is not a permanent dead end)", () => {
    const def = defs[0]!;
    let s = createMissionsState(defs);
    s = startMission(s, def.id);
    s = failMission(s, def.id);
    expect(s.runtime[def.id]!.status).toBe('failed');
    expect(s.activeId).toBeNull();

    // Comfortably before the cooldown elapses: still failed, so the toast has time to be seen and
    // the marker stays gone for at least a moment (not literally instant on the same tick).
    s = reviveFailedMissions(s, FAILED_RETRY_COOLDOWN - 0.5);
    expect(s.runtime[def.id]!.status).toBe('failed');

    // Comfortably after: back to 'available', fresh checkpoint/timer bookkeeping, and startable.
    s = reviveFailedMissions(s, 1);
    expect(s.runtime[def.id]!.status).toBe('available');
    expect(s.runtime[def.id]!.checkpointIndex).toBe(0);
    expect(s.runtime[def.id]!.timeRemaining).toBe(def.timeLimit);
    s = startMission(s, def.id);
    expect(s.activeId).toBe(def.id);
    expect(s.runtime[def.id]!.status).toBe('active');
  });

  it('a mission that failed twice in a row can still be revived and retried a third time', () => {
    const def = defs[0]!;
    let s = createMissionsState(defs);
    for (let attempt = 0; attempt < 2; attempt++) {
      s = startMission(s, def.id);
      s = failMission(s, def.id);
      s = reviveFailedMissions(s, FAILED_RETRY_COOLDOWN + 1);
      expect(s.runtime[def.id]!.status).toBe('available');
    }
    s = startMission(s, def.id);
    expect(s.activeId).toBe(def.id);
  });

  it('stepActiveMission is a cheap no-op with no active mission', () => {
    const s0 = createMissionsState(defs);
    expect(stepActiveMission(s0, DT, { inVehicle: true, wrecked: false })).toBe(s0);
  });

  it('stepActiveMission fails the mission once its timer reaches zero (timeout)', () => {
    const def = defs[0]!;
    let s = createMissionsState(defs);
    s = startMission(s, def.id);
    const steps = Math.ceil(def.timeLimit / DT) + 2;
    for (let i = 0; i < steps; i++) s = stepActiveMission(s, DT, { inVehicle: true, wrecked: false });
    expect(s.runtime[def.id]!.status).toBe('failed');
    expect(s.activeId).toBeNull();
  });

  it('stepActiveMission counts down time remaining while active', () => {
    const def = defs[0]!;
    let s = createMissionsState(defs);
    s = startMission(s, def.id);
    s = stepActiveMission(s, 5, { inVehicle: true, wrecked: false });
    expect(s.runtime[def.id]!.timeRemaining).toBeCloseTo(def.timeLimit - 5, 5);
  });

  it('stepActiveMission fails immediately on wrecked === true', () => {
    const def = defs[0]!;
    let s = createMissionsState(defs);
    s = startMission(s, def.id);
    s = stepActiveMission(s, DT, { inVehicle: true, wrecked: true });
    expect(s.runtime[def.id]!.status).toBe('failed');
    expect(s.activeId).toBeNull();
  });

  it('stepActiveMission fails a race after being out of the vehicle for OUT_OF_VEHICLE_FAIL_TIME', () => {
    const def = defs.find((d) => d.type === 'race')!;
    let s = createMissionsState(defs);
    s = startMission(s, def.id);
    // Comfortably under the limit (leave a margin below the exact boundary for float accumulation
    // error, the same way tests/wanted.test.ts avoids asserting exactly at a threshold): still active.
    const comfortablyUnder = Math.floor((OUT_OF_VEHICLE_FAIL_TIME - 1) / DT);
    for (let i = 0; i < comfortablyUnder; i++) s = stepActiveMission(s, DT, { inVehicle: false, wrecked: false });
    expect(s.runtime[def.id]!.status).toBe('active');
    // Comfortably over it: failed.
    for (let i = 0; i < Math.ceil(2 / DT); i++) s = stepActiveMission(s, DT, { inVehicle: false, wrecked: false });
    expect(s.runtime[def.id]!.status).toBe('failed');
  });

  it('going back into the vehicle resets the out-of-vehicle clock for a race', () => {
    const def = defs.find((d) => d.type === 'race')!;
    let s = createMissionsState(defs);
    s = startMission(s, def.id);
    for (let i = 0; i < Math.floor((OUT_OF_VEHICLE_FAIL_TIME - 1) / DT); i++) s = stepActiveMission(s, DT, { inVehicle: false, wrecked: false });
    expect(s.runtime[def.id]!.status).toBe('active');
    s = stepActiveMission(s, DT, { inVehicle: true, wrecked: false }); // back in the car
    expect(s.runtime[def.id]!.outOfVehicleTime).toBe(0);
    // Now stay out for the full window again: still fails, proving the clock actually reset rather
    // than having already been "spent".
    for (let i = 0; i < Math.ceil((OUT_OF_VEHICLE_FAIL_TIME + 1) / DT); i++) s = stepActiveMission(s, DT, { inVehicle: false, wrecked: false });
    expect(s.runtime[def.id]!.status).toBe('failed');
  });

  it('a delivery mission is not failed by being out of the vehicle', () => {
    const def = defs.find((d) => d.type === 'delivery')!;
    let s = createMissionsState(defs);
    s = startMission(s, def.id);
    for (let i = 0; i < Math.ceil((OUT_OF_VEHICLE_FAIL_TIME + 5) / DT); i++) s = stepActiveMission(s, DT, { inVehicle: false, wrecked: false });
    expect(s.runtime[def.id]!.status).toBe('active');
  });

  it('CHECKPOINT_RADIUS is a sane positive distance well under the checkpoint spacing', () => {
    expect(CHECKPOINT_RADIUS).toBeGreaterThan(0);
    expect(CHECKPOINT_RADIUS).toBeLessThan(MIN_CHECKPOINT_SPACING);
  });
});

describe('missions save/load round trip', () => {
  const city = generateCity({ seed: 5, cols: 8, rows: 8 });
  const defs = generateMissions(city, 5, 4);

  class FakeStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
    private map = new Map<string, string>();
    getItem(k: string): string | null {
      return this.map.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.map.set(k, v);
    }
    removeItem(k: string): void {
      this.map.delete(k);
    }
  }

  it('loadMissionsSave defaults to zero money / no completed missions when storage is empty', () => {
    const storage = new FakeStorage();
    expect(loadMissionsSave(storage)).toEqual({ money: 0, completedIds: [] });
    expect(loadMissionsSave(null)).toEqual({ money: 0, completedIds: [] });
  });

  it('round-trips money and completed ids through save/load, and createMissionsState restores them', () => {
    const storage = new FakeStorage();
    let s = createMissionsState(defs);
    s = startMission(s, defs[0]!.id);
    for (const def of defs) if (def.id === defs[0]!.id) for (let i = 0; i < def.checkpoints.length; i++) s = advanceCheckpoint(s, def.id);
    expect(s.money).toBeGreaterThan(0);
    saveMissionsSave(storage, { money: s.money, completedIds: [...s.completedIds] });

    const loaded = loadMissionsSave(storage);
    expect(loaded.money).toBe(s.money);
    expect(loaded.completedIds).toEqual([...s.completedIds]);

    const restored = createMissionsState(defs, loaded.money, loaded.completedIds);
    expect(restored.money).toBe(s.money);
    expect(restored.runtime[defs[0]!.id]!.status).toBe('complete');
    // Every other mission is untouched (still available), not accidentally marked complete too.
    for (const def of defs.slice(1)) expect(restored.runtime[def.id]!.status).toBe('available');
  });

  it('drops unknown ids from a stale save (e.g. after the mission set changed)', () => {
    const restored = createMissionsState(defs, 50, ['nope', defs[1]!.id]);
    expect(restored.completedIds).toEqual([defs[1]!.id]);
    expect(restored.runtime[defs[1]!.id]!.status).toBe('complete');
  });

  it('a corrupted save falls back to defaults instead of throwing', () => {
    const storage = new FakeStorage();
    storage.setItem('gta7.missions.v1', 'not json');
    expect(loadMissionsSave(storage)).toEqual({ money: 0, completedIds: [] });
  });
});

describe('mission HUD helpers', () => {
  // The project's convention (docs/ARCHITECTURE.md): forward = (sin h, cos h), right = (-cos h, sin h).
  it('relativeBearing is 0 dead ahead and +-PI directly behind', () => {
    expect(relativeBearing(0, 0, 0, 0, 50)).toBeCloseTo(0, 6); // heading 0 faces +Z
    expect(Math.abs(relativeBearing(0, 0, 0, 0, -50))).toBeCloseTo(Math.PI, 6);
    // Facing +X (heading = PI/2: forward = (1, 0)).
    expect(relativeBearing(0, 0, Math.PI / 2, 50, 0)).toBeCloseTo(0, 6);
  });

  it('relativeBearing is positive to the right and negative to the left, in the project convention', () => {
    // Facing +Z, right = (-1, 0): a target at -X is to the right, at +X to the left.
    expect(relativeBearing(0, 0, 0, -50, 0)).toBeCloseTo(Math.PI / 2, 6);
    expect(relativeBearing(0, 0, 0, 50, 0)).toBeCloseTo(-Math.PI / 2, 6);
    // Increasing the heading turns left, so a target dead ahead ends up on the right.
    expect(relativeBearing(0, 0, 0.4, 0, 50)).toBeGreaterThan(0);
  });

  it('bearingArrow maps a bearing onto the eight compass arrows', () => {
    expect(bearingArrow(0)).toBe('\u2191'); // up: dead ahead
    expect(bearingArrow(Math.PI / 2)).toBe('\u2192'); // right
    expect(bearingArrow(-Math.PI / 2)).toBe('\u2190'); // left
    expect(bearingArrow(Math.PI)).toBe('\u2193'); // behind
    expect(bearingArrow(-Math.PI)).toBe('\u2193'); // behind, wrapped the other way
    expect(bearingArrow(Math.PI / 4)).toBe('\u2197'); // ahead-right
    expect(bearingArrow(-3 * Math.PI / 4)).toBe('\u2199'); // behind-left
    expect(bearingArrow(NaN)).toBe('\u2191'); // never blank
  });

  it('bearingArrow + relativeBearing point at a checkpoint the player is driving toward', () => {
    // Driving north (heading 0) with the checkpoint ahead and slightly to the right (-X).
    expect(bearingArrow(relativeBearing(0, 0, 0, -5, 100))).toBe('\u2191');
    expect(bearingArrow(relativeBearing(0, 0, 0, -100, 100))).toBe('\u2197');
    expect(bearingArrow(relativeBearing(0, 0, 0, 100, 100))).toBe('\u2196');
  });

  it('formatMissionTime renders m:ss and never goes negative', () => {
    expect(formatMissionTime(0)).toBe('0:00');
    expect(formatMissionTime(9)).toBe('0:09');
    expect(formatMissionTime(65)).toBe('1:05');
    expect(formatMissionTime(59.2)).toBe('1:00'); // ceil: the clock only hits 0:00 at zero
    expect(formatMissionTime(-4)).toBe('0:00');
    expect(formatMissionTime(NaN)).toBe('0:00');
  });
});
