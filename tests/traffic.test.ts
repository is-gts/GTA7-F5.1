import { describe, expect, it } from 'vitest';
import { generateCity, lanePoint, type CityData } from '../src/world/CityGenerator';
import { Random } from '../src/world/Random';
import { StaticColliderGrid, obbVsOBB } from '../src/physics/Collision';
import { DEFAULT_CAR_SPEC, createVehicleState, vehicleOBB, wrapAngle } from '../src/physics/VehiclePhysics';
import {
  CORNER_RADIUS,
  advanceTrafficAgent,
  chooseNextPath,
  cornerReference,
  createPathReference,
  createTrafficAgent,
  distanceToRoadGraph,
  edgeProgress,
  laneDeviation,
  laneOffsetOf,
  planCorner,
  signedLaneDeviation,
  stepTrafficPopulation,
  type CornerPlan,
  type TrafficAgent,
  type TrafficObstacle,
  type TrafficPath,
} from '../src/ai/Traffic';

const DT = 1 / 60;

function makeCity(seed = 7): CityData {
  return generateCity({ seed, cols: 8, rows: 8 });
}

describe('traffic AI', () => {
  it('stays close to the lane centreline while driving straight (no turn)', () => {
    const city = makeCity();
    // Pick an interior 'x' edge long enough that a slow agent cannot reach either node in 30s.
    const edge = city.roads.edges.find((e) => e.axis === 'x')!;
    const path: TrafficPath = { edgeId: edge.id, forward: true, lane: 0, t: 0.2 };
    const agent = createTrafficAgent(1, city, path, new Random(1), /* cruiseSpeed */ 1.5);

    let maxDeviation = 0;
    for (let i = 0; i < 60 * 30; i++) {
      advanceTrafficAgent(agent, city, DT, []);
      // Never let the agent reach the far ends of the edge (that would introduce a turn).
      expect(agent.path.edgeId).toBe(edge.id);
      const dev = laneDeviation(city, edge, true, 0, agent.state.x, agent.state.z);
      maxDeviation = Math.max(maxDeviation, dev);
    }
    expect(maxDeviation).toBeLessThan(1.2);
  });

  /**
   * Drive one agent around the city for 45 s and watch how it takes the corners it meets.
   *
   * Sampling: *every* step whose (unclamped) progress along the edge it is currently on is >= 0 —
   * i.e. from the node onwards, including the whole junction — up to 0.9. That deliberately covers
   * the metres right after the node, which is exactly where a corner-cutting bug shows up and where
   * an earlier version of this test (which only looked from 15% into the edge, ~12 m past the node)
   * was blind. Two things are checked:
   *  - `signedLaneDeviation >= -1.2` everywhere: the car never gets within half a car's width of the
   *    road centreline, let alone across it into the oncoming lane;
   *  - once clear of the junction (past the fillet's exit tangent, `laneOffset + CORNER_RADIUS` from
   *    the node, plus a settling metre or two) the car is within 1.2 m of its lane centreline.
   * Inside the junction the deviation from the departing lane's centreline is legitimately large —
   * that is what turning across a junction means — so the guarantee there is the road-surface one:
   * the car's centre never leaves the paved road (`distanceToRoadGraph < roadWidth / 2`).
   */
  function driveAround(seed: number, cruiseSpeed: number, lane: number, city = makeCity()) {
    const startEdge = city.roads.edges[seed % city.roads.edges.length]!;
    const path: TrafficPath = { edgeId: startEdge.id, forward: seed % 2 === 0, lane, t: 0.2 };
    const agent = createTrafficAgent(seed, city, path, new Random(seed), cruiseSpeed);
    const settleDist = laneOffsetOf(city.params, lane) + CORNER_RADIUS + 2;
    let rightTurns = 0;
    let leftTurns = 0;
    let minSigned = Infinity;
    let maxSettledDeviation = 0;
    let maxRoadDistance = 0;
    let minSpeed = Infinity;
    for (let i = 0; i < 60 * 45; i++) {
      const beforeEdge = agent.path.edgeId;
      advanceTrafficAgent(agent, city, DT, []);
      if (agent.path.edgeId !== beforeEdge) {
        if (agent.turnAngle < -0.2) rightTurns++;
        else if (agent.turnAngle > 0.2) leftTurns++;
      }
      const edge = city.roads.edges[agent.path.edgeId]!;
      const t = edgeProgress(city, edge, agent.path.forward, agent.state.x, agent.state.z);
      if (t >= 0 && t <= 0.9) {
        const dev = signedLaneDeviation(city, edge, agent.path.forward, agent.path.lane, agent.state.x, agent.state.z);
        minSigned = Math.min(minSigned, dev);
        if (t * edge.length > settleDist) maxSettledDeviation = Math.max(maxSettledDeviation, Math.abs(dev));
      }
      maxRoadDistance = Math.max(maxRoadDistance, distanceToRoadGraph(city, agent.state.x, agent.state.z));
      // Ignore the first two seconds (the agent is still settling onto its lane after spawning).
      if (i > 120) minSpeed = Math.min(minSpeed, agent.state.forwardSpeed);
    }
    return { agent, rightTurns, leftTurns, minSigned, maxSettledDeviation, maxRoadDistance, minSpeed };
  }

  it('turns through junctions without ever crossing onto the oncoming side, on either lane', () => {
    const city = makeCity();
    for (const lane of [0, 1]) {
      let rightTurns = 0;
      let leftTurns = 0;
      for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
        for (const cruiseSpeed of [6, 12]) {
          const r = driveAround(seed, cruiseSpeed, lane, city);
          const where = `lane ${lane}, seed ${seed}, cruise ${cruiseSpeed}`;
          // Never within half a car width of the road centreline (the oncoming side is beyond it).
          expect(r.minSigned, where).toBeGreaterThanOrEqual(-1.2);
          // Back on its own lane centreline once clear of the junction.
          expect(r.maxSettledDeviation, where).toBeLessThan(1.2);
          // Never off the road surface, junctions included.
          expect(r.maxRoadDistance, where).toBeLessThan(city.params.roadWidth / 2);
          // With nothing in its way it keeps rolling (a corner slows it to TURN_SPEED, no further).
          expect(r.minSpeed, where).toBeGreaterThan(1);
          rightTurns += r.rightTurns;
          leftTurns += r.leftTurns;
        }
      }
      // Right turns are the case an arc centred on the node itself gets wrong, so make sure these
      // free-roaming runs really do contain a good number of them. (Left turns come up less often
      // here — which way the shared per-agent RNG sends each car is up to it — so both directions
      // are additionally driven deterministically by the forced-corner test below.)
      expect(rightTurns, `lane ${lane} right turns`).toBeGreaterThan(6);
      expect(leftTurns, `lane ${lane} left turns`).toBeGreaterThanOrEqual(1);
    }
  });

  /**
   * Drive one specific corner deliberately: put the agent 40 m before a 4-way node with its next
   * edge already committed (`pendingPath` + `planCorner` are what the AI itself does one node ahead)
   * so the test controls whether the turn is a left or a right one, on either lane, at either speed.
   * Sampling is as in `driveAround`: from the node onward, junction included.
   */
  function driveForcedCorner(city: CityData, lane: number, wantLeft: boolean, cruiseSpeed: number) {
    const node = city.roads.nodes.find((n) => city.roads.adjacency[n.id]!.length === 4)!;
    const inEdge = city.roads.edges[city.roads.adjacency[node.id]![0]!]!;
    const forward = inEdge.b === node.id;
    const headingIn = lanePoint(city, inEdge, 1, forward, lane).heading;
    let chosen: TrafficPath | null = null;
    for (const outId of city.roads.adjacency[node.id]!) {
      if (outId === inEdge.id) continue;
      const outEdge = city.roads.edges[outId]!;
      const next: TrafficPath = { edgeId: outEdge.id, forward: outEdge.a === node.id, lane, t: 0 };
      const turn = wrapAngle(lanePoint(city, outEdge, 0, next.forward, next.lane).heading - headingIn);
      if (wantLeft ? turn > 0.2 : turn < -0.2) chosen = next;
    }
    const next = chosen!;
    const start: TrafficPath = { edgeId: inEdge.id, forward, lane, t: 1 - 40 / inEdge.length };
    const agent = createTrafficAgent(1, city, start, new Random(7), cruiseSpeed);
    agent.pendingPath = next;
    expect(planCorner(agent.corner, city, inEdge, forward, lane, next, node.id)).toBe(true);

    const settleDist = laneOffsetOf(city.params, lane) + CORNER_RADIUS + 2;
    let switched = false;
    let turnAngle = 0;
    let minSigned = Infinity;
    let maxSettledDeviation = 0;
    let maxRoadDistance = 0;
    for (let i = 0; i < 60 * 30; i++) {
      const beforeEdge = agent.path.edgeId;
      advanceTrafficAgent(agent, city, DT, []);
      if (agent.path.edgeId !== beforeEdge) {
        switched = true;
        turnAngle = agent.turnAngle;
      }
      const edge = city.roads.edges[agent.path.edgeId]!;
      const t = edgeProgress(city, edge, agent.path.forward, agent.state.x, agent.state.z);
      if (switched) {
        if (t >= 0) {
          const dev = signedLaneDeviation(city, edge, agent.path.forward, agent.path.lane, agent.state.x, agent.state.z);
          minSigned = Math.min(minSigned, dev);
          if (t * edge.length > settleDist) maxSettledDeviation = Math.max(maxSettledDeviation, Math.abs(dev));
        }
        // Stop well before the *next* node so only this one corner is measured.
        if (t * edge.length > 34) break;
      }
      maxRoadDistance = Math.max(maxRoadDistance, distanceToRoadGraph(city, agent.state.x, agent.state.z));
    }
    return { switched, turnAngle, minSigned, maxSettledDeviation, maxRoadDistance };
  }

  it('takes a forced left and a forced right corner cleanly, on both lanes', () => {
    const city = makeCity();
    for (const lane of [0, 1]) {
      for (const wantLeft of [false, true]) {
        for (const cruiseSpeed of [6, 12]) {
          const where = `lane ${lane}, ${wantLeft ? 'left' : 'right'}, cruise ${cruiseSpeed}`;
          const r = driveForcedCorner(city, lane, wantLeft, cruiseSpeed);
          expect(r.switched, where).toBe(true);
          expect(wantLeft ? r.turnAngle > 0.2 : r.turnAngle < -0.2, where).toBe(true);
          // Never within half a car width of the road centreline after the node, junction included.
          expect(r.minSigned, where).toBeGreaterThanOrEqual(-1.2);
          expect(r.maxSettledDeviation, where).toBeLessThan(1.2);
          expect(r.maxRoadDistance, where).toBeLessThan(city.params.roadWidth / 2);
        }
      }
    }
  });

  it('builds a corner fillet that is exactly tangent to both lane centrelines', () => {
    const city = makeCity();
    const node = city.roads.nodes.find((n) => city.roads.adjacency[n.id]!.length === 4)!;
    const [inEdgeId, ...outEdgeIds] = city.roads.adjacency[node.id]!;
    const inEdge = city.roads.edges[inEdgeId!]!;
    const forward = inEdge.b === node.id;
    const ref = createPathReference();
    for (const lane of [0, 1]) {
      let turns = 0;
      for (const outId of outEdgeIds) {
        const outEdge = city.roads.edges[outId!]!;
        const next: TrafficPath = { edgeId: outEdge.id, forward: outEdge.a === node.id, lane, t: 0 };
        const corner: CornerPlan = { active: false, committed: false, nodeX: 0, nodeZ: 0, headingIn: 0, dir: 1, laneOffset: 0, radius: CORNER_RADIUS };
        if (!planCorner(corner, city, inEdge, forward, lane, next, node.id)) continue; // straight on
        turns++;
        const d = corner.laneOffset;
        const r = corner.radius;
        const fx = Math.sin(corner.headingIn);
        const fz = Math.cos(corner.headingIn);
        const rx = -fz;
        const rz = fx;
        // Tangent points, in the node-local frame documented on CornerPlan.
        const local = (u: number, w: number) => ({ x: corner.nodeX + u * fx + w * rx, z: corner.nodeZ + u * fz + w * rz });
        const enter = local(corner.dir * d - r, d);
        const exit = local(corner.dir * d, d - corner.dir * r);
        // Both tangent points sit exactly on their lane centreline...
        expect(Math.abs(signedLaneDeviation(city, inEdge, forward, lane, enter.x, enter.z))).toBeLessThan(1e-6);
        expect(Math.abs(signedLaneDeviation(city, outEdge, next.forward, lane, exit.x, exit.z))).toBeLessThan(1e-6);
        // ...and the fillet leaves/joins them pointing along the lane, not across it.
        cornerReference(corner, enter.x, enter.z, ref);
        expect(Math.abs(wrapAngle(ref.heading - lanePoint(city, inEdge, 0.5, forward, lane).heading))).toBeLessThan(1e-6);
        cornerReference(corner, exit.x, exit.z, ref);
        expect(Math.abs(wrapAngle(ref.heading - lanePoint(city, outEdge, 0.5, next.forward, lane).heading))).toBeLessThan(1e-6);
        // The arc's own reference point is always exactly `radius` from the centre.
        const cx = corner.nodeX + (corner.dir * d - r) * fx + (d - corner.dir * r) * rx;
        const cz = corner.nodeZ + (corner.dir * d - r) * fz + (d - corner.dir * r) * rz;
        const mid = local(corner.dir * d - r + r * Math.cos(corner.dir < 0 ? -Math.PI / 4 : Math.PI / 4), d - corner.dir * r + r * Math.sin(corner.dir < 0 ? -Math.PI / 4 : Math.PI / 4));
        cornerReference(corner, mid.x, mid.z, ref);
        expect(Math.hypot(ref.x - cx, ref.z - cz)).toBeCloseTo(r, 6);
      }
      expect(turns).toBe(2); // one left, one right (the third option is straight on)
    }
  });

  it('never leaves the road graph, even while turning at nodes', () => {
    const city = makeCity();
    const edge = city.roads.edges[0]!;
    const path: TrafficPath = { edgeId: edge.id, forward: true, lane: 0, t: 0 };
    const agent = createTrafficAgent(2, city, path, new Random(2), 9);

    for (let i = 0; i < 60 * 30; i++) {
      advanceTrafficAgent(agent, city, DT, []);
      expect(distanceToRoadGraph(city, agent.state.x, agent.state.z)).toBeLessThan(city.params.roadWidth);
    }
  });

  it('picks a valid adjacent edge at a node and never immediately reverses at a 4-way intersection', () => {
    const city = makeCity();
    // An interior node has degree 4 (a real intersection).
    const interior = city.roads.nodes.find((n) => city.roads.adjacency[n.id]!.length === 4)!;
    const arrivalEdgeId = city.roads.adjacency[interior.id]![0]!;
    const rng = new Random(99);
    for (let i = 0; i < 200; i++) {
      const next = chooseNextPath(city, rng, interior.id, arrivalEdgeId, 0);
      expect(next.edgeId).not.toBe(arrivalEdgeId);
      expect(city.roads.adjacency[interior.id]).toContain(next.edgeId);
    }
    // A dead-end (degree 1) node is the one case where reversing is the only option.
    const deadEnd = city.roads.nodes.find((n) => city.roads.adjacency[n.id]!.length === 1);
    if (deadEnd) {
      const onlyEdge = city.roads.adjacency[deadEnd.id]![0]!;
      const next = chooseNextPath(city, rng, deadEnd.id, onlyEdge, 0);
      expect(next.edgeId).toBe(onlyEdge);
    }
  });

  it('slows and stops behind a stationary vehicle ahead without overlapping it', () => {
    const city = makeCity();
    const edge = city.roads.edges.find((e) => e.axis === 'x')!;
    const leadPath: TrafficPath = { edgeId: edge.id, forward: true, lane: 0, t: 0.5 };
    const followerPath: TrafficPath = { edgeId: edge.id, forward: true, lane: 0, t: 0.1 };
    const lead = createTrafficAgent(10, city, leadPath, new Random(10), 0); // parked / stationary
    const follower = createTrafficAgent(11, city, followerPath, new Random(11), 9);

    for (let i = 0; i < 60 * 10; i++) {
      stepTrafficPopulation([lead, follower], city, DT, {});
    }
    expect(Math.abs(lead.state.forwardSpeed)).toBeLessThan(0.5);
    expect(Math.abs(follower.state.forwardSpeed)).toBeLessThan(1);
    const gap = Math.hypot(follower.state.x - lead.state.x, follower.state.z - lead.state.z);
    expect(gap).toBeGreaterThan(DEFAULT_CAR_SPEC.halfLength * 2);
    expect(obbVsOBB(vehicleOBB(follower.state, follower.spec), vehicleOBB(lead.state, lead.spec))).toBeNull();
  });

  it('also yields to (and never overlaps) the player vehicle counted as an obstacle', () => {
    const city = makeCity();
    const edge = city.roads.edges.find((e) => e.axis === 'x')!;
    const followerPath: TrafficPath = { edgeId: edge.id, forward: true, lane: 0, t: 0.1 };
    const follower = createTrafficAgent(20, city, followerPath, new Random(20), 9);
    const playerLane = lanePoint(city, edge, 0.4, true, 0);
    const player = { state: createVehicleState(playerLane.x, playerLane.z, playerLane.heading), spec: DEFAULT_CAR_SPEC };

    for (let i = 0; i < 60 * 8; i++) {
      const obstacle: TrafficObstacle = {
        x: player.state.x,
        z: player.state.z,
        heading: player.state.heading,
        forwardSpeed: player.state.forwardSpeed,
        halfLength: player.spec.halfLength,
        halfWidth: player.spec.halfWidth,
      };
      advanceTrafficAgent(follower, city, DT, [obstacle]);
    }
    expect(obbVsOBB(vehicleOBB(follower.state, follower.spec), vehicleOBB(player.state, player.spec))).toBeNull();
  });

  it('resolves against static obstacles when a grid is supplied', () => {
    const city = makeCity();
    const edge = city.roads.edges.find((e) => e.axis === 'x')!;
    const grid = new StaticColliderGrid(32);
    const na = city.roads.nodes[edge.a]!;
    // A wall placed squarely across the lane, close ahead of the agent.
    grid.insert({ id: 1, minX: na.x + 15, minZ: na.z - 20, maxX: na.x + 17, maxZ: na.z + 20 });
    const path: TrafficPath = { edgeId: edge.id, forward: true, lane: 0, t: 0.02 };
    const agent = createTrafficAgent(30, city, path, new Random(30), 12);
    for (let i = 0; i < 60 * 5; i++) advanceTrafficAgent(agent, city, DT, [], grid);
    expect(agent.state.x).toBeLessThanOrEqual(na.x + 15 + DEFAULT_CAR_SPEC.halfLength + 1e-6);
  });

  /**
   * Run a population and report the longest stretch (s) any agent spent below 0.3 m/s and the
   * distance each of them actually drove (path length, not displacement — traffic goes in circles).
   */
  function trackStops(agents: readonly TrafficAgent[], run: number, step: (i: number) => void): { longestStop: number; travelled: number[] } {
    const last = agents.map((a) => ({ x: a.state.x, z: a.state.z }));
    const travelled = agents.map(() => 0);
    const stopped = agents.map(() => 0);
    let longestStop = 0;
    for (let i = 0; i < run; i++) {
      step(i);
      for (let k = 0; k < agents.length; k++) {
        const a = agents[k]!;
        travelled[k] = travelled[k]! + Math.hypot(a.state.x - last[k]!.x, a.state.z - last[k]!.z);
        last[k]!.x = a.state.x;
        last[k]!.z = a.state.z;
        stopped[k] = Math.abs(a.state.forwardSpeed) < 0.3 ? stopped[k]! + DT : 0;
        longestStop = Math.max(longestStop, stopped[k]!);
      }
    }
    return { longestStop, travelled };
  }

  /**
   * How far right of the *road* centreline the agent is (metres). This is the real "is it on its own
   * side of the road" measure: unlike the deviation from one lane's centreline it does not move when
   * an agent legitimately changes lane, so it can be sampled continuously through a whole run.
   */
  function distanceRightOfCentreline(city: CityData, agent: TrafficAgent): number {
    const edge = city.roads.edges[agent.path.edgeId]!;
    const dev = signedLaneDeviation(city, edge, agent.path.forward, agent.path.lane, agent.state.x, agent.state.z);
    return dev + laneOffsetOf(city.params, agent.path.lane);
  }

  it('keeps a whole population moving: nobody is stuck, nobody overlaps', () => {
    const city = makeCity();
    const rng = new Random(99);
    const agents: TrafficAgent[] = [];
    for (let i = 0; i < 12; i++) {
      const edge = city.roads.edges[(i * 17) % city.roads.edges.length]!;
      const path: TrafficPath = { edgeId: edge.id, forward: i % 2 === 0, lane: i % 2, t: 0.25 + 0.03 * i };
      agents.push(createTrafficAgent(i + 1, city, path, rng.fork(`agent:${i}`), 6 + (i % 7)));
    }
    const grid = new StaticColliderGrid(32);
    let closestToCentreline = Infinity;
    const { longestStop, travelled } = trackStops(agents, 60 * 40, () => {
      stepTrafficPopulation(agents, city, DT, { grid });
      for (const a of agents) {
        const edge = city.roads.edges[a.path.edgeId]!;
        const t = edgeProgress(city, edge, a.path.forward, a.state.x, a.state.z);
        // Only away from the junctions, where "sides of the road" is a meaningful idea.
        if (t > 0.15 && t < 0.85) closestToCentreline = Math.min(closestToCentreline, distanceRightOfCentreline(city, a));
      }
    });
    // Nobody ever strays onto the oncoming half of the road while overtaking, cornering or
    // recovering from a bump.
    expect(closestToCentreline).toBeGreaterThan(0.9);
    // No agent sits still for any length of time (there is nothing in this city to wait for), and
    // every one of them covers real ground rather than shuffling on the spot: 40 s at the 4.5 m/s
    // corner speed alone would be 180 m.
    expect(longestStop).toBeLessThan(4);
    for (const d of travelled) expect(d).toBeGreaterThan(150);
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        expect(obbVsOBB(vehicleOBB(agents[i]!.state, agents[i]!.spec), vehicleOBB(agents[j]!.state, agents[j]!.spec))).toBeNull();
      }
    }
  });

  it('frees itself from a head-on standoff instead of deadlocking', () => {
    // The failure this guards against: a car facing another car in its lane treats it as a leader
    // and matches its (zero) speed, while the other one does the same — neither rule ever changes
    // its mind, so both sit there for ever. Here `b` sits stopped on `a`'s side of the road.
    const city = makeCity();
    const edge = city.roads.edges.find((e) => e.axis === 'x')!;
    const a = createTrafficAgent(1, city, { edgeId: edge.id, forward: true, lane: 0, t: 0.4 }, new Random(1), 8);
    const b = createTrafficAgent(2, city, { edgeId: edge.id, forward: false, lane: 0, t: 0.55 }, new Random(2), 8);
    b.state.x = a.state.x + edge.length * 0.12;
    b.state.z = a.state.z + 0.8;
    b.state.heading = a.state.heading + Math.PI;
    b.state.vx = 0;
    b.state.vz = 0;
    b.state.forwardSpeed = 0;

    let bothMovingAt = Infinity;
    for (let i = 0; i < 60 * 20; i++) {
      stepTrafficPopulation([a, b], city, DT, {});
      if (a.state.forwardSpeed > 1 && b.state.forwardSpeed > 1) bothMovingAt = Math.min(bothMovingAt, i * DT);
    }
    // Both are driving again within a few seconds of getting stuck...
    expect(bothMovingAt).toBeLessThan(8);
    // ...and have gone their separate ways by the end (they started ~9 m apart, facing each other).
    expect(Math.hypot(a.state.x - b.state.x, a.state.z - b.state.z)).toBeGreaterThan(40);
    expect(obbVsOBB(vehicleOBB(a.state, a.spec), vehicleOBB(b.state, b.spec))).toBeNull();
  });

  it('goes around a parked car blocking its lane (but still queues behind stopped traffic)', () => {
    // The city's parked cars sit on lane centrelines, so this is the everyday case: an obstacle
    // that will never move again. Traffic pulls out around it. Contrast the "slows and stops behind
    // a stationary vehicle" test above: a stopped *agent* is a queue and is followed, not passed —
    // the difference is `TrafficObstacle.parked`.
    const city = makeCity();
    const edge = city.roads.edges.find((e) => e.axis === 'x')!;
    for (const lane of [0, 1]) {
      const spot = lanePoint(city, edge, 0.55, true, lane);
      const parked: TrafficObstacle = { x: spot.x, z: spot.z, heading: spot.heading, forwardSpeed: 0, halfLength: 2.25, halfWidth: 0.95, parked: true };
      const agents: TrafficAgent[] = [];
      for (let i = 0; i < 3; i++) {
        agents.push(createTrafficAgent(i + 1, city, { edgeId: edge.id, forward: true, lane, t: 0.35 - 0.07 * i }, new Random(i + 1), 9));
      }
      let closestToCentreline = Infinity;
      const { longestStop, travelled } = trackStops(agents, 60 * 30, () => {
        stepTrafficPopulation(agents, city, DT, { extraObstacles: [parked] });
        for (const a of agents) {
          const e = city.roads.edges[a.path.edgeId]!;
          const t = edgeProgress(city, e, a.path.forward, a.state.x, a.state.z);
          if (t > 0.15 && t < 0.85) closestToCentreline = Math.min(closestToCentreline, distanceRightOfCentreline(city, a));
        }
      });
      expect(longestStop, `lane ${lane}`).toBeLessThan(8);
      // Getting past it uses the other lane on its own side of the road, never the oncoming one.
      expect(closestToCentreline, `lane ${lane}`).toBeGreaterThan(0.9);
      // The leader gets past and carries on across the city rather than waiting behind it for ever.
      expect(travelled[0]!, `lane ${lane}`).toBeGreaterThan(100);
      for (const a of agents) {
        expect(obbVsOBB(vehicleOBB(a.state, a.spec), { x: parked.x, z: parked.z, halfW: parked.halfWidth, halfL: parked.halfLength, heading: parked.heading })).toBeNull();
      }
    }
  });

  it('does not freeze behind a vehicle abandoned in an intersection', () => {
    // e.g. the player parks their car in the middle of a junction. Waiting can never clear it, so
    // the traffic behind edges around it instead of freezing for good. The crossing really is
    // blocked, so progress is slow — what matters is that it never stops: no agent sits still for
    // long, and all of them keep covering ground.
    const city = makeCity();
    const node = city.roads.nodes.find((n) => city.roads.adjacency[n.id]!.length === 4)!;
    const edge = city.roads.edges[city.roads.adjacency[node.id]![0]!]!;
    const forward = edge.b === node.id;
    const agents: TrafficAgent[] = [];
    for (let i = 0; i < 3; i++) {
      const t = forward ? 0.5 - 0.1 * i : 0.5 + 0.1 * i;
      agents.push(createTrafficAgent(i + 1, city, { edgeId: edge.id, forward, lane: 0, t }, new Random(i + 1), 8));
    }
    const parked: TrafficObstacle = { x: node.x, z: node.z, heading: 0.7, forwardSpeed: 0, halfLength: 2.25, halfWidth: 0.95 };
    const { longestStop, travelled } = trackStops(agents, 60 * 30, () => stepTrafficPopulation(agents, city, DT, { extraObstacles: [parked] }));
    // A frozen queue would show a stop of 25 s+ and barely 15 m of travel (the distance to the
    // junction) for the lead car.
    expect(longestStop).toBeLessThan(10);
    for (const d of travelled) expect(d).toBeGreaterThan(30);
  });

  it('is deterministic: two identical populations given the same seed evolve identically', () => {
    function run(): TrafficAgent[] {
      const city = makeCity(5);
      const seedRng = new Random(123);
      const edges = city.roads.edges;
      const agents: TrafficAgent[] = [];
      for (let i = 0; i < 6; i++) {
        const edge = edges[(i * 13) % edges.length]!;
        const path: TrafficPath = { edgeId: edge.id, forward: i % 2 === 0, lane: i % 2, t: 0.1 + 0.05 * i };
        agents.push(createTrafficAgent(i + 1, city, path, seedRng.fork(`agent:${i}`), 6 + i));
      }
      const grid = new StaticColliderGrid(32);
      for (let i = 0; i < 60 * 8; i++) stepTrafficPopulation(agents, city, DT, { grid });
      return agents;
    }
    const a = run();
    const b = run();
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.state).toEqual(b[i]!.state);
      expect(a[i]!.path).toEqual(b[i]!.path);
    }
  });
});
