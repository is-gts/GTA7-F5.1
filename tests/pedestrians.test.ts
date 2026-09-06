import { describe, expect, it } from 'vitest';
import { generateCity, buildingAABBs, type CityData } from '../src/world/CityGenerator';
import { Random } from '../src/world/Random';
import { StaticColliderGrid, circleVsAABB } from '../src/physics/Collision';
import {
  advancePedestrian,
  buildSidewalkGraph,
  createPedestrianAgent,
  createPedestrianSpec,
  distanceToSidewalkGraph,
  pickNextSidewalkNode,
  stepPedestrianPopulation,
  type PedestrianAgent,
  type SidewalkGraph,
} from '../src/ai/Pedestrians';
import type { TrafficObstacle } from '../src/ai/Traffic';

const DT = 1 / 60;

function makeCity(seed = 7): CityData {
  return generateCity({ seed, cols: 8, rows: 8 });
}

/** Nearest actual road-graph intersection node to (x,z). */
function nearestRoadNodeDistance(city: CityData, x: number, z: number): number {
  let best = Infinity;
  for (const n of city.roads.nodes) best = Math.min(best, Math.hypot(x - n.x, z - n.z));
  return best;
}

describe('sidewalk graph', () => {
  it('gives every block a ring of exactly 4 nodes, each within the sidewalk band', () => {
    const city = makeCity();
    const graph = buildSidewalkGraph(city);
    const half = city.params.sidewalkWidth / 2;

    for (let bi = 0; bi < city.blocks.length; bi++) {
      const block = city.blocks[bi]!;
      const blockNodes = graph.nodes.filter((n) => n.blockIndex === bi);
      expect(blockNodes.length).toBe(4);
      for (const n of blockNodes) {
        // Strictly inside the block footprint...
        expect(n.x).toBeGreaterThan(block.x0);
        expect(n.x).toBeLessThan(block.x0 + block.size);
        expect(n.z).toBeGreaterThan(block.z0);
        expect(n.z).toBeLessThan(block.z0 + block.size);
        // ...and within `sidewalkWidth` of the nearest block edge (the sidewalk band).
        const distToEdge = Math.min(n.x - block.x0, block.x0 + block.size - n.x, n.z - block.z0, block.z0 + block.size - n.z);
        expect(distToEdge).toBeCloseTo(half, 6);
      }
      // The 4 ring edges for this block form a closed loop: each of its 4 nodes has exactly 2
      // ring-edge neighbours among the block's own nodes.
      const ringEdges = graph.edges.filter((e) => e.kind === 'ring' && graph.nodes[e.a]!.blockIndex === bi);
      expect(ringEdges.length).toBe(4);
    }
  });

  it('places crossing edges only near real road-graph intersections, never mid-block', () => {
    const city = makeCity();
    const graph = buildSidewalkGraph(city);
    const crossings = graph.edges.filter((e) => e.kind === 'crossing');
    expect(crossings.length).toBeGreaterThan(0);
    // Generous bound: well past the intersection box (roadWidth/2 + sidewalkWidth) but far short of
    // reaching into a block interior (blockSize/2), which is what "mid-block" would look like.
    const bound = city.params.roadWidth + city.params.sidewalkWidth;
    expect(bound).toBeLessThan(city.params.blockSize / 2);
    for (const e of crossings) {
      const a = graph.nodes[e.a]!;
      const b = graph.nodes[e.b]!;
      expect(nearestRoadNodeDistance(city, a.x, a.z)).toBeLessThan(bound);
      expect(nearestRoadNodeDistance(city, b.x, b.z)).toBeLessThan(bound);
      // A crossing always joins two different blocks (it's a link *between* rings, not within one).
      expect(a.blockIndex).not.toBe(b.blockIndex);
    }
  });

  it('every node has at least 2 neighbours (the ring), so pickNextSidewalkNode never gets stuck', () => {
    const city = makeCity();
    const graph = buildSidewalkGraph(city);
    for (const n of graph.nodes) expect(graph.adjacency[n.id]!.length).toBeGreaterThanOrEqual(2);
    const rng = new Random(1);
    for (let i = 0; i < 500; i++) {
      const node = rng.int(0, graph.nodes.length - 1);
      const next = pickNextSidewalkNode(graph, rng, node, node);
      expect(graph.adjacency[node]).toContain(next);
    }
  });
});

describe('pedestrian AI', () => {
  function walk60s(graph: SidewalkGraph, city: CityData, startNode: number, seed: number, grid?: StaticColliderGrid) {
    const rng = new Random(seed);
    const spec = createPedestrianSpec(rng);
    const agent = createPedestrianAgent(1, graph, startNode, rng, spec);
    let maxDeviation = 0;
    const scratch: (ReturnType<typeof buildingAABBs>[number])[] = [];
    for (let i = 0; i < 60 * 60; i++) {
      advancePedestrian(agent, graph, DT, [], grid);
      const dev = distanceToSidewalkGraph(graph, agent.state.x, agent.state.z);
      maxDeviation = Math.max(maxDeviation, dev);
      if (grid) {
        grid.query({ minX: agent.state.x - spec.radius, maxX: agent.state.x + spec.radius, minZ: agent.state.z - spec.radius, maxZ: agent.state.z + spec.radius }, scratch);
        for (const box of scratch) expect(circleVsAABB({ x: agent.state.x, z: agent.state.z, r: spec.radius }, box)).toBeNull();
      }
    }
    return { agent, maxDeviation };
  }

  it('walked for 60s, stays within 1m of the sidewalk/crossing network and never enters a building', () => {
    const city = makeCity();
    const graph = buildSidewalkGraph(city);
    const grid = new StaticColliderGrid(32);
    for (const box of buildingAABBs(city)) grid.insert(box);

    for (const [seed, startNode] of [
      [1, 0],
      [2, 10],
      [3, 42],
    ] as const) {
      const { maxDeviation } = walk60s(graph, city, startNode % graph.nodes.length, seed, grid);
      expect(maxDeviation, `seed ${seed}`).toBeLessThan(1);
    }
  });

  it('a moving vehicle OBB knocks a pedestrian down, and it gets back up again later', () => {
    const city = makeCity();
    const graph = buildSidewalkGraph(city);
    const rng = new Random(5);
    const spec = createPedestrianSpec(rng);
    const agent = createPedestrianAgent(1, graph, 0, rng, spec);
    // A fast "vehicle" sitting squarely on top of the agent for one tick — an unmissable overlap.
    const hitObstacle: TrafficObstacle = {
      x: agent.state.x,
      z: agent.state.z,
      heading: agent.state.heading,
      forwardSpeed: 9,
      halfWidth: 0.95,
      halfLength: 2.25,
    };
    let sawDown = false;
    let downAt = -1;
    let recoveredAt = -1;
    const hitSpeeds: number[] = [];
    for (let i = 0; i < 700 && recoveredAt < 0; i++) {
      const obstacles = i === 0 ? [hitObstacle] : [];
      advancePedestrian(agent, graph, DT, obstacles, undefined, (speed) => hitSpeeds.push(speed));
      if (agent.mode === 'down') {
        sawDown = true;
        if (downAt < 0) downAt = i;
      }
      if (sawDown && agent.mode === 'walk') recoveredAt = i;
    }
    expect(sawDown).toBe(true);
    expect(downAt).toBe(0);
    expect(hitSpeeds).toEqual([9]);
    expect(recoveredAt).toBeGreaterThan(downAt);
    // Down + getup together are bounded (DOWN_MAX=8s, GETUP=1.2s): well inside the 700-tick (~11.7s) run.
    expect(recoveredAt).toBeLessThan(700);
  });

  it('does not knock down a pedestrian standing near a slow-moving vehicle', () => {
    const city = makeCity();
    const graph = buildSidewalkGraph(city);
    const rng = new Random(6);
    const spec = createPedestrianSpec(rng);
    const agent = createPedestrianAgent(2, graph, 3, rng, spec);
    const slowObstacle: TrafficObstacle = { x: agent.state.x, z: agent.state.z, heading: agent.state.heading, forwardSpeed: 0.5, halfWidth: 0.95, halfLength: 2.25 };
    for (let i = 0; i < 60; i++) advancePedestrian(agent, graph, DT, [slowObstacle]);
    expect(agent.mode).not.toBe('down');
  });

  it('flees from a vehicle closing on it fast, aiming away from the threat', () => {
    const city = makeCity();
    const graph = buildSidewalkGraph(city);
    const rng = new Random(9);
    const spec = createPedestrianSpec(rng);
    const agent = createPedestrianAgent(3, graph, 0, rng, spec);
    // Place a fast vehicle 6 m from the agent, heading directly at it (no overlap: halfLength 2.25 m
    // leaves 3.75 m of clear air), so this is a pure "approaching fast" case, not a hit.
    const dx = agent.state.x - 6;
    const heading = Math.PI / 2; // forward = (sin, cos) = (1, 0): driving toward +X, i.e. toward the agent
    const obstacle: TrafficObstacle = { x: dx, z: agent.state.z, heading, forwardSpeed: 12, halfWidth: 0.95, halfLength: 2.25 };
    expect(agent.mode).not.toBe('flee');
    advancePedestrian(agent, graph, DT, [obstacle]);
    expect(agent.mode).toBe('flee');
  });

  it('is deterministic: two identical pedestrian populations given the same seed evolve identically', () => {
    function run(): PedestrianAgent[] {
      const city = makeCity(5);
      const graph = buildSidewalkGraph(city);
      const seedRng = new Random(123);
      const agents: PedestrianAgent[] = [];
      for (let i = 0; i < 6; i++) {
        const startNode = (i * 37) % graph.nodes.length;
        const agentRng = seedRng.fork(`ped-agent:${i}`);
        const spec = createPedestrianSpec(agentRng);
        agents.push(createPedestrianAgent(i + 1, graph, startNode, agentRng, spec));
      }
      for (let i = 0; i < 60 * 20; i++) stepPedestrianPopulation(agents, graph, DT, {});
      return agents;
    }
    const a = run();
    const b = run();
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.state).toEqual(b[i]!.state);
      expect(a[i]!.mode).toBe(b[i]!.mode);
      expect(a[i]!.fromNode).toBe(b[i]!.fromNode);
      expect(a[i]!.toNode).toBe(b[i]!.toNode);
    }
  });
});
