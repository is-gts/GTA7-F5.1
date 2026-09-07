/** Minimal DOM heads-up display: speed, mode, performance, wanted level and control hints. */
export interface HUDData {
  speedKmh: number;
  mode: 'foot' | 'vehicle';
  fps: number;
  frameMs: number;
  quality: string;
  renderScale: number;
  drawCalls: number;
  triangles: number;
  aa: string;
  ao: string;
  shadows: string;
  timeOfDay: number;
  hint: string;
  /** Wanted level 0..5 (see `src/game/Wanted.ts`); renders as filled/empty stars. */
  wanted: number;
  /** Busted overlay: shown while true (player was caught by police and is respawning). */
  busted: boolean;
}

const FILLED_STAR = '★';
const EMPTY_STAR = '☆';
const MAX_WANTED_STARS = 5;

export class HUD {
  private readonly root: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly unit: HTMLElement;
  private readonly perf: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly wanted: HTMLElement;
  private readonly busted: HTMLElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWanted = -1;
  private lastBusted = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-speed"><span class="hud-speed-value">0</span><span class="hud-speed-unit">km/h</span></div>
      <div class="hud-perf"></div>
      <div class="hud-hint"></div>
      <div class="hud-wanted"></div>
      <div class="hud-money">$0</div>
      <div class="hud-busted" hidden>BUSTED</div>
      <div class="hud-toast" hidden></div>`;
    container.appendChild(this.root);
    this.speed = this.root.querySelector('.hud-speed-value')!;
    this.unit = this.root.querySelector('.hud-speed-unit')!;
    this.perf = this.root.querySelector('.hud-perf')!;
    this.hint = this.root.querySelector('.hud-hint')!;
    this.toast = this.root.querySelector('.hud-toast')!;
    this.wanted = this.root.querySelector('.hud-wanted')!;
    this.busted = this.root.querySelector('.hud-busted')!;
    // Draw the (empty) star row immediately: `update()` is throttled to ~4 Hz by the caller, so
    // without this the wanted row is missing entirely for the first frames after boot.
    this.wanted.textContent = EMPTY_STAR.repeat(MAX_WANTED_STARS);
    this.lastWanted = 0;
    // Money/score placeholder (no economy system yet — just the HUD real estate for one, per spec).
  }

  update(d: HUDData): void {
    this.speed.textContent = String(Math.round(d.speedKmh));
    this.unit.textContent = d.mode === 'vehicle' ? 'km/h' : 'on foot';
    const h = Math.floor(d.timeOfDay);
    const mm = Math.floor((d.timeOfDay - h) * 60);
    this.perf.textContent =
      `${d.fps.toFixed(0)} fps · ${d.frameMs.toFixed(1)} ms · ${d.quality} · scale ${d.renderScale.toFixed(2)} · ` +
      `${d.drawCalls} draws · ${(d.triangles / 1000).toFixed(0)}k tris · AA ${d.aa} · AO ${d.ao} · shadows ${d.shadows} · ${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    this.hint.textContent = d.hint;
    if (d.wanted !== this.lastWanted) {
      this.lastWanted = d.wanted;
      const level = Math.max(0, Math.min(MAX_WANTED_STARS, Math.round(d.wanted)));
      this.wanted.textContent = FILLED_STAR.repeat(level) + EMPTY_STAR.repeat(MAX_WANTED_STARS - level);
    }
    if (d.busted !== this.lastBusted) {
      this.lastBusted = d.busted;
      this.busted.hidden = !d.busted;
    }
  }

  /** Show/hide the performance line (fps/ms/draw calls/...) — the "HUD performance overlay" toggle
   *  in the settings menu. Speed/hint/wanted/busted stay visible either way. */
  setPerfOverlayVisible(visible: boolean): void {
    this.perf.hidden = !visible;
  }

  showToast(text: string, ms = 2200): void {
    this.toast.textContent = text;
    this.toast.hidden = false;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.hidden = true;
    }, ms);
  }

  dispose(): void {
    this.root.remove();
  }
}
