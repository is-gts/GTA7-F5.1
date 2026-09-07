/**
 * Pause / settings menu: a DOM overlay opened with Esc (or the touch gear button) that exposes
 * every `QualitySettings` knob plus a handful of gameplay settings, live-applies them through
 * `Game.applyQuality`/`Game.applyGameplaySettings`, and persists the result.
 *
 * Rendering-cost knobs (sliders whose `input` event fires continuously while dragging) go through
 * `Debounced` so a drag only rebuilds the pipeline once, ~`DEBOUNCE_S` after the pointer stops
 * moving; discrete controls (`<select>`, checkboxes, preset buttons) apply immediately on `change`.
 * `set(key, value)` — the automation entry point exposed as `window.__gta7.menu.set` — always
 * applies immediately, bypassing the debounce, so tests don't need to wait out a timer.
 *
 * Game owns the callbacks (`MenuCallbacks`): this class touches no three.js/game state directly,
 * only DOM plus the small pure `Debounced` accumulator.
 */
import { AVAILABLE_AA_MODES } from '../render/PostPipeline';
import { Debounced } from '../core/Debounced';
import {
  isCustomQuality,
  isGameplaySettingsKey,
  isPresetName,
  isQualitySettingsKey,
  nearestPreset,
  type GameplaySettings,
  type QualityPresetName,
  type QualitySettings,
} from '../core/Quality';

export interface MenuStats {
  /** `Engine.stats.frame` — rendering keeps advancing this even while the game is paused/menu is
   *  open, so the benchmark can measure real frame time without unpausing gameplay. */
  frame: number;
  drawCalls: number;
}

export interface MenuCallbacks {
  getQuality(): QualitySettings;
  getGameplay(): GameplaySettings;
  getTimeOfDay(): number;
  /** Called when the menu opens or closes (pauses/resumes the game, unlocks the pointer). */
  onOpenChange(open: boolean): void;
  /** A preset button (or "Reset to preset") was clicked: replace the whole quality object. */
  onPreset(name: QualityPresetName): void;
  /** One or more knobs changed: shallow-merge `patch` onto the current quality and re-apply. */
  onQualityChange(patch: Partial<QualitySettings>): void;
  onGameplayChange(patch: Partial<GameplaySettings>): void;
  onTimeOfDay(hours: number): void;
  onRestart(): void;
  getStats(): MenuStats;
}

type Kind = 'range' | 'select' | 'toggle';

interface KnobBase {
  key: string;
  label: string;
  kind: Kind;
  /** Sliders debounce (continuous `input` events); selects/checkboxes apply immediately on `change`. */
  debounce: boolean;
  /** Only enabled (not just visible) while this returns true for the current quality — e.g.
   *  `msaaSamples` only matters when `aa === 'msaa'`. */
  enabledWhen?: (q: QualitySettings) => boolean;
}
interface RangeKnob extends KnobBase {
  kind: 'range';
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}
interface SelectKnob extends KnobBase {
  kind: 'select';
  options: readonly (string | number)[];
  numeric?: boolean;
}
interface ToggleKnob extends KnobBase {
  kind: 'toggle';
}
type Knob = RangeKnob | SelectKnob | ToggleKnob;

const QUALITY_KNOBS: Knob[] = [
  { key: 'renderScale', label: 'Render scale', kind: 'range', min: 0.5, max: 2, step: 0.05, debounce: true, format: (v) => v.toFixed(2) },
  { key: 'adaptiveResolution', label: 'Adaptive resolution', kind: 'toggle', debounce: false },
  { key: 'targetFps', label: 'Adaptive target FPS', kind: 'range', min: 20, max: 120, step: 5, debounce: true, format: (v) => String(Math.round(v)) },
  { key: 'aa', label: 'Anti-aliasing', kind: 'select', options: AVAILABLE_AA_MODES, debounce: false },
  { key: 'msaaSamples', label: 'MSAA samples', kind: 'select', options: [2, 4, 8], numeric: true, debounce: false, enabledWhen: (q) => q.aa === 'msaa' },
  { key: 'ao', label: 'Ambient occlusion', kind: 'select', options: ['none', 'ssao', 'gtao'], debounce: false },
  { key: 'aoScale', label: 'AO resolution', kind: 'range', min: 0.5, max: 1, step: 0.1, debounce: true, format: (v) => v.toFixed(1), enabledWhen: (q) => q.ao !== 'none' },
  { key: 'bloom', label: 'Bloom', kind: 'toggle', debounce: false },
  { key: 'toneMapping', label: 'Tone mapping', kind: 'select', options: ['aces', 'agx', 'neutral'], debounce: false },
  { key: 'shadows', label: 'Shadows', kind: 'select', options: ['none', 'single', 'csm'], debounce: false },
  { key: 'shadowMapSize', label: 'Shadow map size', kind: 'select', options: [512, 1024, 2048, 4096], numeric: true, debounce: false, enabledWhen: (q) => q.shadows !== 'none' },
  { key: 'shadowCascades', label: 'Shadow cascades', kind: 'select', options: [1, 2, 3, 4], numeric: true, debounce: false, enabledWhen: (q) => q.shadows === 'csm' },
  { key: 'shadowDistance', label: 'Shadow distance', kind: 'range', min: 50, max: 500, step: 10, debounce: true, format: (v) => `${Math.round(v)} m`, enabledWhen: (q) => q.shadows !== 'none' },
  { key: 'softShadows', label: 'Soft shadows', kind: 'toggle', debounce: false, enabledWhen: (q) => q.shadows !== 'none' },
  { key: 'drawDistance', label: 'Draw distance', kind: 'range', min: 100, max: 800, step: 10, debounce: true, format: (v) => `${Math.round(v)} m` },
  { key: 'farDistance', label: 'Far distance', kind: 'range', min: 300, max: 2000, step: 50, debounce: true, format: (v) => `${Math.round(v)} m` },
  { key: 'anisotropy', label: 'Anisotropic filtering', kind: 'select', options: [1, 2, 4, 8, 16], numeric: true, debounce: false },
  { key: 'envReflections', label: 'Environment reflections', kind: 'toggle', debounce: false },
  { key: 'maxTraffic', label: 'Traffic density', kind: 'range', min: 0, max: 80, step: 2, debounce: true, format: (v) => String(Math.round(v)) },
  { key: 'maxPedestrians', label: 'Pedestrian density', kind: 'range', min: 0, max: 80, step: 2, debounce: true, format: (v) => String(Math.round(v)) },
  { key: 'propDensity', label: 'Prop density', kind: 'range', min: 0, max: 1, step: 0.05, debounce: true, format: (v) => `${Math.round(v * 100)}%` },
  { key: 'maxLocalLights', label: 'Street lights', kind: 'range', min: 0, max: 16, step: 1, debounce: true, format: (v) => String(Math.round(v)) },
];

const GAMEPLAY_KNOBS: Knob[] = [
  { key: 'invertMouseY', label: 'Invert mouse Y', kind: 'toggle', debounce: false },
  { key: 'fov', label: 'Field of view', kind: 'range', min: 55, max: 90, step: 1, debounce: true, format: (v) => `${Math.round(v)}°` },
  { key: 'daySpeed', label: 'Day length (s/hour)', kind: 'range', min: 10, max: 300, step: 5, debounce: true, format: (v) => `${Math.round(v)}s` },
  { key: 'hudPerfOverlay', label: 'HUD performance overlay', kind: 'toggle', debounce: false },
];

const PRESETS: QualityPresetName[] = ['low', 'medium', 'high', 'ultra'];
const QUALITY_DEBOUNCE_S = 0.35;
const GAMEPLAY_DEBOUNCE_S = 0.35;
const TOD_DEBOUNCE_S = 0.15;
const BENCHMARK_MS = 5000;

export class Menu {
  readonly root: HTMLElement;
  private open_ = false;
  private basePreset: QualityPresetName;
  private benchmarking = false;

  private readonly pendingQuality = new Debounced<Partial<QualitySettings>>(QUALITY_DEBOUNCE_S);
  private readonly pendingGameplay = new Debounced<Partial<GameplaySettings>>(GAMEPLAY_DEBOUNCE_S);
  private readonly pendingTod = new Debounced<number>(TOD_DEBOUNCE_S);

  private readonly customBadge: HTMLElement;
  private readonly presetButtons: Partial<Record<QualityPresetName, HTMLButtonElement>> = {};
  private readonly benchmarkBtn: HTMLButtonElement;
  private readonly benchmarkResultEl: HTMLElement;
  private readonly todInput: HTMLInputElement;
  private readonly todValueEl: HTMLElement;
  private readonly qualityInputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  private readonly gameplayInputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  private readonly valueLabels = new Map<string, HTMLElement>();

  constructor(container: HTMLElement, private readonly cb: MenuCallbacks) {
    const q = cb.getQuality();
    // A saved (or `?q.*`-overridden) record only records `preset: 'custom'`, so the preset the
    // custom settings were derived from has to be recovered by similarity — otherwise
    // "Reset to preset" would jump to an arbitrary default after every reload.
    this.basePreset = nearestPreset(q);

    this.root = document.createElement('div');
    this.root.className = 'settings-menu';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="sm-panel" role="dialog" aria-label="Settings">
        <div class="sm-header">
          <h2>Settings</h2>
          <div class="sm-presets">
            ${PRESETS.map((p) => `<button type="button" class="sm-preset-btn" data-preset="${p}">${p}</button>`).join('')}
            <span class="sm-custom-badge" hidden>custom</span>
          </div>
        </div>
        <div class="sm-body">
          <section class="sm-section"><h3>Graphics</h3>${QUALITY_KNOBS.map((k) => this.knobHtml(k)).join('')}</section>
          <section class="sm-section">
            <h3>Gameplay</h3>
            <label class="sm-row" data-key="timeOfDay">
              <span class="sm-label">Time of day</span>
              <input type="range" min="0" max="24" step="0.25" data-key="timeOfDay" />
              <span class="sm-value" data-key-value="timeOfDay"></span>
            </label>
            ${GAMEPLAY_KNOBS.map((k) => this.knobHtml(k)).join('')}
          </section>
        </div>
        <div class="sm-footer">
          <button type="button" class="sm-btn" data-action="reset">Reset to preset</button>
          <button type="button" class="sm-btn" data-action="restart">Restart game</button>
          <button type="button" class="sm-btn" data-action="benchmark">Benchmark (5s)</button>
          <span class="sm-benchmark-result" data-el="benchmarkResult"></span>
          <button type="button" class="sm-btn sm-btn-primary" data-action="resume">Resume</button>
        </div>
      </div>`;
    container.appendChild(this.root);

    for (const p of PRESETS) this.presetButtons[p] = this.root.querySelector<HTMLButtonElement>(`[data-preset="${p}"]`)!;
    this.customBadge = this.root.querySelector('.sm-custom-badge')!;
    this.benchmarkBtn = this.root.querySelector('[data-action="benchmark"]')!;
    this.benchmarkResultEl = this.root.querySelector('[data-el="benchmarkResult"]')!;
    this.todInput = this.root.querySelector('input[data-key="timeOfDay"]')!;
    this.todValueEl = this.root.querySelector('[data-key-value="timeOfDay"]')!;

    for (const k of QUALITY_KNOBS) this.qualityInputs.set(k.key, this.root.querySelector(`[data-key="${k.key}"]`)!);
    for (const k of GAMEPLAY_KNOBS) this.gameplayInputs.set(k.key, this.root.querySelector(`[data-key="${k.key}"]`)!);
    for (const k of [...QUALITY_KNOBS, ...GAMEPLAY_KNOBS]) {
      const val = this.root.querySelector(`[data-key-value="${k.key}"]`);
      if (val) this.valueLabels.set(k.key, val as HTMLElement);
    }

    this.wire();
    this.refreshFromState();
  }

  private knobHtml(k: Knob): string {
    const valueSpan = k.kind === 'range' ? `<span class="sm-value" data-key-value="${k.key}"></span>` : '';
    let control: string;
    if (k.kind === 'range') {
      control = `<input type="range" data-key="${k.key}" min="${k.min}" max="${k.max}" step="${k.step}" />`;
    } else if (k.kind === 'select') {
      control = `<select data-key="${k.key}">${k.options.map((o) => `<option value="${o}">${o}</option>`).join('')}</select>`;
    } else {
      control = `<input type="checkbox" data-key="${k.key}" />`;
    }
    return `<label class="sm-row" data-row="${k.key}"><span class="sm-label">${k.label}</span>${control}${valueSpan}</label>`;
  }

  private wire(): void {
    for (const [name, btn] of Object.entries(this.presetButtons)) {
      btn!.addEventListener('click', () => {
        this.basePreset = name as QualityPresetName;
        this.pendingQuality.cancel();
        this.cb.onPreset(name as QualityPresetName);
        this.refreshFromState();
      });
    }
    this.root.querySelector('[data-action="resume"]')!.addEventListener('click', () => this.close());
    this.root.querySelector('[data-action="restart"]')!.addEventListener('click', () => {
      this.cb.onRestart();
      this.close();
    });
    this.root.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
      this.pendingQuality.cancel();
      this.cb.onPreset(this.basePreset);
      this.refreshFromState();
    });
    this.root.querySelector('[data-action="benchmark"]')!.addEventListener('click', () => this.runBenchmark());

    this.todInput.addEventListener('input', () => {
      const v = Number(this.todInput.value);
      this.todValueEl.textContent = formatHours(v);
      this.pendingTod.push(v);
    });
    this.todInput.addEventListener('change', () => {
      const v = Number(this.todInput.value);
      this.pendingTod.cancel();
      this.cb.onTimeOfDay(v);
    });

    for (const k of QUALITY_KNOBS) this.wireKnob(k, this.qualityInputs, (patch) => this.queueQuality(patch, !k.debounce));
    for (const k of GAMEPLAY_KNOBS) this.wireKnob(k, this.gameplayInputs, (patch) => this.queueGameplay(patch, !k.debounce));
  }

  private wireKnob(k: Knob, inputs: Map<string, HTMLInputElement | HTMLSelectElement>, apply: (patch: Record<string, unknown>) => void): void {
    const el = inputs.get(k.key)!;
    const read = (): unknown => {
      if (k.kind === 'toggle') return (el as HTMLInputElement).checked;
      if (k.kind === 'select') return k.numeric ? Number(el.value) : el.value;
      return Number(el.value);
    };
    const label = this.valueLabels.get(k.key);
    const updateLabel = () => {
      if (!label || k.kind !== 'range') return;
      const v = Number(el.value);
      label.textContent = k.format ? k.format(v) : String(v);
    };
    updateLabel();
    if (k.kind === 'range') {
      // Continuous drag: live-update the label immediately, debounce the (expensive) apply.
      el.addEventListener('input', () => {
        updateLabel();
        apply({ [k.key]: read() });
      });
    } else {
      el.addEventListener('change', () => apply({ [k.key]: read() }));
    }
  }

  private queueQuality(patch: Partial<QualitySettings>, immediate: boolean): void {
    if (immediate) {
      const flushed = this.pendingQuality.flush();
      this.applyQualityPatch({ ...(flushed ?? {}), ...patch });
    } else {
      this.pendingQuality.push(patch, (prev, next) => ({ ...prev, ...next }));
    }
  }

  private queueGameplay(patch: Partial<GameplaySettings>, immediate: boolean): void {
    if (immediate) {
      const flushed = this.pendingGameplay.flush();
      this.applyGameplayPatch({ ...(flushed ?? {}), ...patch });
    } else {
      this.pendingGameplay.push(patch, (prev, next) => ({ ...prev, ...next }));
    }
  }

  private applyQualityPatch(patch: Partial<QualitySettings>): void {
    // Any manual knob change stops tracking a preset (matches main.ts's `?q.*=` URL overrides).
    this.cb.onQualityChange({ ...patch, preset: 'custom' });
    this.refreshFromState();
  }

  private applyGameplayPatch(patch: Partial<GameplaySettings>): void {
    this.cb.onGameplayChange(patch);
    this.refreshFromState();
  }

  /** Called every render frame (see `Game.render`) — advances the debounce clocks and (while a
   *  benchmark is running) is a no-op, since the benchmark samples wall time directly via rAF. */
  tick(dt: number): void {
    const q = this.pendingQuality.tick(dt);
    if (q) this.applyQualityPatch(q);
    const g = this.pendingGameplay.tick(dt);
    if (g) this.applyGameplayPatch(g);
    const t = this.pendingTod.tick(dt);
    if (t !== null) this.cb.onTimeOfDay(t);
  }

  /** Re-read quality/gameplay/time-of-day from the callbacks and refresh every control's displayed
   *  value, the preset/custom badge, and which controls are enabled. Idempotent. */
  refreshFromState(): void {
    const q = this.cb.getQuality();
    const g = this.cb.getGameplay();
    for (const [name, btn] of Object.entries(this.presetButtons)) {
      btn!.classList.toggle('active', q.preset === name);
    }
    const custom = isCustomQuality(q);
    // Track the last preset the quality actually *was* (including presets applied outside the menu,
    // e.g. the 1-4 hotkeys), so "Reset to preset" returns to it rather than to a stale one.
    if (isPresetName(q.preset)) this.basePreset = q.preset;
    this.customBadge.hidden = !custom;
    for (const k of QUALITY_KNOBS) this.refreshKnob(k, this.qualityInputs, q as unknown as Record<string, unknown>, q);
    for (const k of GAMEPLAY_KNOBS) this.refreshKnob(k, this.gameplayInputs, g as unknown as Record<string, unknown>, q);
    if (!this.pendingTod.isPending) {
      const hours = this.cb.getTimeOfDay();
      this.todInput.value = String(hours);
      this.todValueEl.textContent = formatHours(hours);
    }
  }

  private refreshKnob(k: Knob, inputs: Map<string, HTMLInputElement | HTMLSelectElement>, source: Record<string, unknown>, q: QualitySettings): void {
    const el = inputs.get(k.key)!;
    el.disabled = k.enabledWhen ? !k.enabledWhen(q) : false;
    const pendingPatch = this.qualityInputs.has(k.key) ? this.pendingQuality.peek() : this.pendingGameplay.peek();
    if (pendingPatch && Object.prototype.hasOwnProperty.call(pendingPatch, k.key)) return; // mid-drag: don't stomp it
    const v = source[k.key];
    if (k.kind === 'toggle') (el as HTMLInputElement).checked = Boolean(v);
    else el.value = String(v);
    const label = this.valueLabels.get(k.key);
    if (label && k.kind === 'range') {
      const rk = k as RangeKnob;
      label.textContent = rk.format ? rk.format(Number(v)) : String(v);
    }
  }

  private runBenchmark(): void {
    if (this.benchmarking) return;
    if (typeof requestAnimationFrame !== 'function' || typeof performance === 'undefined') {
      this.benchmarkResultEl.textContent = 'Benchmark unavailable';
      return;
    }
    this.benchmarking = true;
    this.benchmarkBtn.disabled = true;
    this.benchmarkResultEl.textContent = 'Benchmarking…';
    const start = performance.now();
    const startStats = this.cb.getStats();
    const sample = (): void => {
      const now = performance.now();
      if (now - start < BENCHMARK_MS) {
        requestAnimationFrame(sample);
        return;
      }
      const endStats = this.cb.getStats();
      const elapsedMs = now - start;
      const frames = Math.max(0, endStats.frame - startStats.frame);
      if (frames > 0) {
        const avgMs = elapsedMs / frames;
        this.benchmarkResultEl.textContent = `${avgMs.toFixed(2)} ms/frame (${(1000 / avgMs).toFixed(0)} fps) · ${endStats.drawCalls} draw calls · ${frames} frames`;
      } else {
        this.benchmarkResultEl.textContent = 'No frames rendered (game is not running)';
      }
      this.benchmarking = false;
      this.benchmarkBtn.disabled = false;
    };
    requestAnimationFrame(sample);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    this.root.hidden = false;
    this.refreshFromState();
    this.cb.onOpenChange(true);
  }

  close(): void {
    if (!this.open_) return;
    // Any slider still mid-debounce applies now rather than being lost.
    const q = this.pendingQuality.flush();
    if (q) this.applyQualityPatch(q);
    const g = this.pendingGameplay.flush();
    if (g) this.applyGameplayPatch(g);
    const t = this.pendingTod.flush();
    if (t !== null) this.cb.onTimeOfDay(t);
    this.open_ = false;
    this.root.hidden = true;
    // Move focus out of the menu before hiding it. Chromium keeps dispatching key events at the
    // last focused element even once it is hidden, so a still-focused Resume/preset button would
    // otherwise keep receiving (and, in `Input`, could keep shadowing) the player's gameplay keys.
    this.blurSelf();
    this.cb.onOpenChange(false);
  }

  /** Drop DOM focus if it currently sits on one of this menu's controls. */
  private blurSelf(): void {
    if (typeof document === 'undefined') return;
    const active = document.activeElement;
    if (active && active !== document.body && this.root.contains(active) && typeof (active as HTMLElement).blur === 'function') {
      (active as HTMLElement).blur();
    }
  }

  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  /** Automation entry point (`window.__gta7.menu.set`): applies a single knob immediately,
   *  bypassing the debounce, whatever section it belongs to. */
  set(key: string, value: unknown): void {
    if (key === 'timeOfDay') {
      this.pendingTod.cancel();
      this.cb.onTimeOfDay(Number(value));
      this.refreshFromState();
    } else if (key === 'preset' && isPresetName(value)) {
      this.basePreset = value;
      this.pendingQuality.cancel();
      this.cb.onPreset(value);
      this.refreshFromState();
    } else if (isQualitySettingsKey(key)) {
      this.applyQualityPatch({ [key]: value } as Partial<QualitySettings>);
    } else if (isGameplaySettingsKey(key)) {
      this.applyGameplayPatch({ [key]: value } as Partial<GameplaySettings>);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

function formatHours(h: number): string {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
