import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../src/core/Quality';
import {
  EVENT_COOLDOWN,
  HEAT_MAX,
  LOSE_TIME,
  MAX_LEVEL,
  POLICE_CONTACT_RANGE,
  addWantedHeat,
  createWantedState,
  levelForHeat,
  policeCountForLevel,
  stepWanted,
} from '../src/game/Wanted';

const DT = 1 / 60;

describe('wanted state machine', () => {
  it('starts at level 0 / heat 0', () => {
    const w = createWantedState();
    expect(w.level).toBe(0);
    expect(w.heat).toBe(0);
    expect(w.secondsSincePoliceContact).toBe(0);
  });

  it('a pedestrian hit raises the level to at least 1', () => {
    const w = addWantedHeat(createWantedState(), 'pedestrianHit');
    expect(w.level).toBeGreaterThanOrEqual(1);
    expect(w.heat).toBeGreaterThan(0);
  });

  it('a police contact event adds more heat than a pedestrian hit or vehicle crash', () => {
    const fromPed = addWantedHeat(createWantedState(), 'pedestrianHit');
    const fromCrash = addWantedHeat(createWantedState(), 'vehicleCrash');
    const fromPolice = addWantedHeat(createWantedState(), 'policeContact');
    expect(fromPolice.heat).toBeGreaterThan(fromPed.heat);
    expect(fromPolice.heat).toBeGreaterThan(fromCrash.heat);
  });

  it('level rises monotonically with accumulated heat and thresholds are respected', () => {
    let w = createWantedState();
    let lastLevel = 0;
    for (let i = 0; i < 6; i++) {
      // Separate incidents: let the per-kind debounce (EVENT_COOLDOWN) expire between them.
      for (let t = 0; t < Math.round(2 / DT); t++) w = stepWanted(w, DT, true);
      w = addWantedHeat(w, 'pedestrianHit');
      expect(w.level).toBeGreaterThanOrEqual(lastLevel);
      lastLevel = w.level;
    }
    expect(w.level).toBe(5); // capped at 5 stars
    expect(w.heat).toBeLessThanOrEqual(HEAT_MAX);
  });

  it('levelForHeat is a monotonic step function bounded to [0, 5]', () => {
    expect(levelForHeat(0)).toBe(0);
    expect(levelForHeat(19.999)).toBe(0);
    expect(levelForHeat(20)).toBe(1);
    expect(levelForHeat(39)).toBe(1);
    expect(levelForHeat(40)).toBe(2);
    expect(levelForHeat(100)).toBe(5);
    expect(levelForHeat(1000)).toBe(5);
  });

  it('an event resets the "lose them" clock even mid-decay', () => {
    let w = addWantedHeat(createWantedState(), 'pedestrianHit');
    for (let i = 0; i < 300; i++) w = stepWanted(w, DT, false); // 5s with no police contact
    expect(w.secondsSincePoliceContact).toBeGreaterThan(0);
    w = addWantedHeat(w, 'vehicleCrash');
    expect(w.secondsSincePoliceContact).toBe(0);
  });

  it('heat neither grows nor decays while police remain nearby', () => {
    let w = addWantedHeat(createWantedState(), 'pedestrianHit');
    const heat0 = w.heat;
    for (let i = 0; i < 600; i++) w = stepWanted(w, DT, true); // 10s of continuous contact
    expect(w.heat).toBe(heat0);
    expect(w.level).toBe(levelForHeat(heat0));
    expect(w.secondsSincePoliceContact).toBe(0);
  });

  it('heat (and level) stay frozen while waiting out the lose-them clock, then drop to zero exactly at LOSE_TIME', () => {
    // Max out heat so this exercises the "held, not drained" behaviour at the top of the range too.
    let w = createWantedState();
    for (let i = 0; i < 5; i++) {
      for (let t = 0; t < Math.round(2 / DT); t++) w = stepWanted(w, DT, true);
      w = addWantedHeat(w, 'policeContact');
    }
    expect(w.heat).toBe(HEAT_MAX);
    const steps = Math.round((LOSE_TIME / 2) / DT);
    for (let i = 0; i < steps; i++) w = stepWanted(w, DT, false);
    // Halfway through the lose-them window: still the same heat/level, not drained.
    expect(w.heat).toBe(HEAT_MAX);
    expect(w.level).toBe(MAX_LEVEL);
  });

  it('a maxed-out wanted level loses the level entirely by LOSE_TIME seconds with no police contact', () => {
    let w = createWantedState();
    for (let i = 0; i < 5; i++) {
      for (let t = 0; t < Math.round(2 / DT); t++) w = stepWanted(w, DT, true);
      w = addWantedHeat(w, 'policeContact');
    }
    const stepsShortly = Math.round(1 / DT); // 1s in: nowhere near lost yet
    for (let i = 0; i < stepsShortly; i++) w = stepWanted(w, DT, false);
    expect(w.level).toBeGreaterThan(0);

    const stepsToFinish = Math.round((LOSE_TIME - 1) / DT); // total elapsed now >= LOSE_TIME
    for (let i = 0; i < stepsToFinish; i++) w = stepWanted(w, DT, false);
    expect(w.heat).toBe(0);
    expect(w.level).toBe(0);
  });

  it('a level-1 (non-maxed) wanted state lingers at level 1 right up to LOSE_TIME, not a moment sooner', () => {
    let w = addWantedHeat(createWantedState(), 'pedestrianHit'); // heat 20 -> level 1
    expect(w.level).toBe(1);
    const startHeat = w.heat;
    // Just under LOSE_TIME (19s): still level 1, heat unchanged — this is the regression the wanted
    // system must not repeat (heat used to drain at a flat HEAT_MAX/LOSE_TIME rate regardless of the
    // level it started from, so a level-1 state lost its star after a single tick).
    for (let i = 0; i < Math.round(19 / DT); i++) w = stepWanted(w, DT, false);
    expect(w.level).toBe(1);
    expect(w.heat).toBe(startHeat);
    // At/after LOSE_TIME (20s total): fully lost.
    for (let i = 0; i < Math.round(1 / DT); i++) w = stepWanted(w, DT, false);
    expect(w.level).toBe(0);
    expect(w.heat).toBe(0);
  });

  it('an idle (already zero) state is a stable fixed point of stepWanted', () => {
    const w0 = createWantedState();
    const w1 = stepWanted(w0, DT, false);
    expect(w1).toEqual(w0);
  });

  it('policeCountForLevel scales 1:1 with the wanted level and is clamped to [0, 5]', () => {
    expect(policeCountForLevel(0)).toBe(0);
    expect(policeCountForLevel(1)).toBe(1);
    expect(policeCountForLevel(3)).toBe(3);
    expect(policeCountForLevel(5)).toBe(5);
    expect(policeCountForLevel(-2)).toBe(0);
    expect(policeCountForLevel(9)).toBe(5);
  });

  it('policeCountForLevel is clamped by the quality preset\'s maxPolice budget', () => {
    expect(policeCountForLevel(5, 3)).toBe(3);
    expect(policeCountForLevel(2, 3)).toBe(2);
    expect(policeCountForLevel(5, 0)).toBe(0);
    // Every shipped preset allows at least one pursuing car, and never more than 5 stars' worth.
    for (const q of Object.values(QUALITY_PRESETS)) {
      expect(q.maxPolice).toBeGreaterThanOrEqual(1);
      expect(policeCountForLevel(MAX_LEVEL, q.maxPolice)).toBeLessThanOrEqual(MAX_LEVEL);
      expect(policeCountForLevel(1, q.maxPolice)).toBe(1);
    }
  });

  it('repeat events of the same kind within the debounce window add no extra heat', () => {
    let w = addWantedHeat(createWantedState(), 'policeContact');
    const heat0 = w.heat;
    // A collision that bounces reports several contacts in consecutive ticks: only the first counts.
    for (let i = 0; i < 10; i++) {
      w = stepWanted(w, DT, true);
      w = addWantedHeat(w, 'policeContact');
    }
    expect(w.heat).toBe(heat0);
    // ...and a genuinely separate incident, once the debounce has expired, does count.
    for (let i = 0; i < Math.round(EVENT_COOLDOWN.policeContact / DT) + 2; i++) w = stepWanted(w, DT, true);
    w = addWantedHeat(w, 'policeContact');
    expect(w.heat).toBeGreaterThan(heat0);
    // A different kind of event is debounced independently.
    const before = w.heat;
    w = addWantedHeat(w, 'pedestrianHit');
    expect(w.heat).toBeGreaterThan(before);
  });

  it('createWantedState fully resets (used on busted)', () => {
    let w = addWantedHeat(createWantedState(), 'policeContact');
    w = addWantedHeat(w, 'policeContact');
    expect(w.level).toBeGreaterThan(0);
    const reset = createWantedState();
    expect(reset.level).toBe(0);
    expect(reset.heat).toBe(0);
  });

  it('POLICE_CONTACT_RANGE is a sane positive distance', () => {
    expect(POLICE_CONTACT_RANGE).toBeGreaterThan(0);
  });
});
