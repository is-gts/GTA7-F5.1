/**
 * Game loop with a fixed simulation timestep and variable-rate rendering.
 *
 * - `update(dt)` is called with a constant `fixedDelta` zero or more times per frame.
 * - `render(alpha, frameDelta)` is called once per frame; `alpha` is the interpolation factor
 *   between the previous and current simulation state (0..1).
 *
 * The loop is driver-agnostic: `tick(nowSeconds)` may be called from requestAnimationFrame
 * or manually from tests for deterministic stepping.
 */
export interface EngineSystem {
  /** Fixed-step simulation. */
  update?(dt: number): void;
  /** Per-frame rendering / interpolation. */
  render?(alpha: number, frameDelta: number): void;
}

export interface EngineOptions {
  /** Fixed simulation timestep in seconds. Default 1/60. */
  fixedDelta?: number;
  /** Maximum frame time accepted per tick (spiral-of-death guard). Default 0.1s. */
  maxFrameDelta?: number;
  /** Maximum number of fixed updates per tick. Default 8. */
  maxSubSteps?: number;
}

export interface FrameStats {
  /** Frames rendered since start. */
  frame: number;
  /** Fixed updates executed since start. */
  updates: number;
  /** Last frame delta (seconds, clamped). */
  frameDelta: number;
  /** Exponential moving average of frame delta (seconds). */
  avgFrameDelta: number;
  /** Simulation time (seconds). */
  simTime: number;
}

export class Engine {
  readonly fixedDelta: number;
  readonly maxFrameDelta: number;
  readonly maxSubSteps: number;

  private readonly systems: EngineSystem[] = [];
  private accumulator = 0;
  private lastTime: number | null = null;
  private rafId: number | null = null;
  private running = false;

  readonly stats: FrameStats = {
    frame: 0,
    updates: 0,
    frameDelta: 0,
    avgFrameDelta: 1 / 60,
    simTime: 0,
  };

  constructor(options: EngineOptions = {}) {
    this.fixedDelta = options.fixedDelta ?? 1 / 60;
    this.maxFrameDelta = options.maxFrameDelta ?? 0.1;
    this.maxSubSteps = options.maxSubSteps ?? 8;
    if (!(this.fixedDelta > 0)) throw new Error('fixedDelta must be > 0');
  }

  addSystem(system: EngineSystem): () => void {
    this.systems.push(system);
    return () => this.removeSystem(system);
  }

  removeSystem(system: EngineSystem): void {
    const i = this.systems.indexOf(system);
    if (i >= 0) this.systems.splice(i, 1);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Advance the loop to `nowSeconds`. Runs as many fixed updates as have accumulated,
   * then renders once. Returns the number of fixed updates executed.
   */
  tick(nowSeconds: number): number {
    if (this.lastTime === null) this.lastTime = nowSeconds;
    let frameDelta = nowSeconds - this.lastTime;
    this.lastTime = nowSeconds;
    if (frameDelta < 0) frameDelta = 0;
    if (frameDelta > this.maxFrameDelta) frameDelta = this.maxFrameDelta;

    this.stats.frameDelta = frameDelta;
    this.stats.avgFrameDelta += (frameDelta - this.stats.avgFrameDelta) * 0.1;

    this.accumulator += frameDelta;
    let steps = 0;
    while (this.accumulator >= this.fixedDelta && steps < this.maxSubSteps) {
      for (const s of this.systems) s.update?.(this.fixedDelta);
      this.accumulator -= this.fixedDelta;
      this.stats.simTime += this.fixedDelta;
      this.stats.updates++;
      steps++;
    }
    // If we hit the sub-step cap, drop the remainder to avoid a death spiral.
    if (steps === this.maxSubSteps && this.accumulator >= this.fixedDelta) {
      this.accumulator = 0;
    }

    const alpha = this.accumulator / this.fixedDelta;
    for (const s of this.systems) s.render?.(alpha, frameDelta);
    this.stats.frame++;
    return steps;
  }

  /** Run exactly one fixed update and one render (useful for tests / pause stepping). */
  stepOnce(): void {
    for (const s of this.systems) s.update?.(this.fixedDelta);
    this.stats.simTime += this.fixedDelta;
    this.stats.updates++;
    for (const s of this.systems) s.render?.(0, this.fixedDelta);
    this.stats.frame++;
  }

  start(): void {
    if (this.running) return;
    if (typeof requestAnimationFrame !== 'function') {
      throw new Error('Engine.start requires requestAnimationFrame; use tick() in headless contexts');
    }
    this.running = true;
    this.lastTime = null;
    const loop = (ms: number) => {
      if (!this.running) return;
      this.tick(ms / 1000);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  }

  /** Reset timing so the next tick does not produce a huge delta (e.g. after tab resume). */
  resetTiming(): void {
    this.lastTime = null;
    this.accumulator = 0;
  }
}
