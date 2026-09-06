/** Minimal DOM heads-up display: speed, mode, performance and control hints. */
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
}

export class HUD {
  private readonly root: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly unit: HTMLElement;
  private readonly perf: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly toast: HTMLElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-speed"><span class="hud-speed-value">0</span><span class="hud-speed-unit">km/h</span></div>
      <div class="hud-perf"></div>
      <div class="hud-hint"></div>
      <div class="hud-toast" hidden></div>`;
    container.appendChild(this.root);
    this.speed = this.root.querySelector('.hud-speed-value')!;
    this.unit = this.root.querySelector('.hud-speed-unit')!;
    this.perf = this.root.querySelector('.hud-perf')!;
    this.hint = this.root.querySelector('.hud-hint')!;
    this.toast = this.root.querySelector('.hud-toast')!;
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
