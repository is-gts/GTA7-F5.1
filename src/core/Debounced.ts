/**
 * Time-accumulator debounce, driven by explicit `tick(dt)` calls rather than real timers — same
 * "fed by whoever owns the clock" shape as `AdaptiveResolution` in `Quality.ts`, so it stays pure
 * and unit-testable without fake timers, and ticks naturally from `Game.render()`'s frame delta.
 *
 * Used by `src/ui/Menu.ts` to coalesce rapid slider drags (each `push` resets the quiet-time clock)
 * before triggering an expensive pipeline rebuild, while discrete controls (a `<select>`, a
 * checkbox) can bypass it entirely via `flush()`.
 */
export class Debounced<T> {
  private pending: T | null = null;
  private elapsed = 0;

  /** @param delaySeconds quiet time required after the last `push` before `tick` returns a value. */
  constructor(private readonly delaySeconds: number) {}

  get isPending(): boolean {
    return this.pending !== null;
  }

  /** Read the pending value without consuming it, or `null` if nothing is pending. */
  peek(): T | null {
    return this.pending;
  }

  /**
   * Queue `value` (optionally merged onto whatever is already pending via `merge`) and reset the
   * quiet-time clock.
   */
  push(value: T, merge?: (prev: T, next: T) => T): void {
    this.pending = this.pending !== null && merge ? merge(this.pending, value) : value;
    this.elapsed = 0;
  }

  /**
   * Advance the quiet-time clock by `dt` seconds. Returns the pending value (and clears it) once
   * `delaySeconds` have elapsed since the last `push`; otherwise `null`.
   */
  tick(dt: number): T | null {
    if (this.pending === null) return null;
    this.elapsed += Math.max(0, dt);
    if (this.elapsed < this.delaySeconds) return null;
    return this.take();
  }

  /** Return the pending value immediately (skipping the remaining quiet time) and clear it, or
   *  `null` if nothing is pending. */
  flush(): T | null {
    if (this.pending === null) return null;
    return this.take();
  }

  /** Discard any pending value without returning it. */
  cancel(): void {
    this.pending = null;
    this.elapsed = 0;
  }

  private take(): T {
    const v = this.pending as T;
    this.pending = null;
    this.elapsed = 0;
    return v;
  }
}
