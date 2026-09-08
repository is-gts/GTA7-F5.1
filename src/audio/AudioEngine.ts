/**
 * Procedural WebAudio engine: everything is synthesised (oscillators + filtered noise) — no audio
 * assets, no network fetches. The `AudioContext` is created lazily, on the first real key/pointer/
 * touch gesture (`attachGestureListeners`), never before; every public method is a safe no-op if
 * WebAudio is unavailable, construction throws, or the context has been closed, so the game never
 * breaks without sound (headless test runners included).
 *
 * The DSP *parameter* logic (RPM/gear mapping, crash amplitude, siren tone schedule, distance
 * attenuation) lives in `AudioModel.ts` as plain, unit-tested functions; this file is only the node
 * graph and the per-tick plumbing that feeds them.
 */
import { Random } from '../world/Random';
import { crashAmplitude, distanceAttenuation, rpmFromSpeed, screechGain, sirenFrequency, SIREN_LOW_HZ } from './AudioModel';

export interface AudioSnapshot {
  started: boolean;
  muted: boolean;
  voices: number;
  /** `AudioContext.state`, or null before `start()` / without WebAudio — informational only
   *  (headless Chromium may stay 'suspended' forever; that's an accepted, non-error outcome). */
  contextState: AudioContextState | null;
}

/** One nearby traffic car sampled for a pooled quiet engine voice (see `Game.updateAudio`). */
export interface TrafficVoiceSample {
  distance: number;
  speed: number;
}

export interface AudioUpdateInput {
  /** Simulation time in seconds (`Engine.stats.simTime`) — drives the siren's tone schedule as a
   *  pure function of sim time rather than wall clock (matches `Rain`/`MissionMarkers`). */
  simTime: number;
  driving: boolean;
  speed: number;
  throttle: number;
  lateralSpeed: number;
  handbrake: boolean;
  /** Surface wetness (0..1, see `world/Weather.ts`) — scales the rain noise bed. */
  wetness: number;
  /** Nearest traffic cars, ascending by distance, already capped to `TRAFFIC_VOICE_POOL_SIZE`. */
  traffic: readonly TrafficVoiceSample[];
  /** Distance (m) to the nearest police car (`PoliceSystem.nearestDistance`); ignored unless `pursuing`. */
  policeDistance: number;
  pursuing: boolean;
}

/** Size of the pooled traffic-engine voice pool (a hard cap; `setTrafficBudget` — driven by the
 *  quality preset's `audioTrafficVoices` — further limits how many of these are actually used). */
export const TRAFFIC_VOICE_POOL_SIZE = 4;

const MASTER_GAIN = 0.7;
/** Output limiter (a `DynamicsCompressorNode` at a high ratio) — the individual voice gains are all
 *  modest, but a crash burst on top of engine + screech + siren + four traffic voices can still sum
 *  past full scale and clip. Threshold in dBFS. */
const LIMITER_THRESHOLD_DB = -6;
const AMBIENT_GAIN = 0.05;
const ENGINE_GAIN = 0.22;
const TRAFFIC_GAIN = 0.06;
const TRAFFIC_MAX_DISTANCE = 45;
const SIREN_GAIN = 0.35;
const SIREN_MAX_DISTANCE = 90;
const SCREECH_GAIN_SCALE = 0.3;
const RAIN_GAIN_SCALE = 0.18;
const CRASH_GAIN_SCALE = 0.9;
const CRASH_COOLDOWN_S = 0.12;
const HORN_GAIN = 0.22;
const HORN_DURATION_S = 0.35;
const NOISE_BUFFER_SECONDS = 2;
/** AudioParam ramp time constant (s) used for most continuous parameter updates. */
const RAMP = 0.05;

/** Clamp to [0,1], NaN included (see `AudioModel.clamp`: an `AudioParam` throws on a non-finite
 *  value, which would abort the rest of the tick's parameter updates). */
function clamp01(v: number): number {
  return v >= 0 ? (v > 1 ? 1 : v) : 0;
}

/** Run `fn`, swallowing any exception (construction can throw in odd/headless environments) and
 *  returning `null` instead of propagating — the whole point of this module being "safe no-op". */
function safely<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

interface TrafficSlot {
  osc: OscillatorNode;
  gain: GainNode;
  active: boolean;
  /** Last gear this voice's `rpmFromSpeed` chose, for hysteretic (chatter-free) shifting. */
  gear: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Unused bus, kept silent — present so the graph has the "master/music/sfx" shape the task
   *  calls for even though nothing plays music yet. */
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private supported = true;
  private startedFlag = false;
  private mutedFlag = false;
  /** Set while the game is paused (settings menu open): folded into the master gain alongside
   *  `mutedFlag`, so a paused game doesn't keep droning its engine and siren. */
  private pausedFlag = false;
  private gestureTarget: EventTarget | null = null;
  private readonly onGesture = (): void => this.start();

  // engine (player's driven vehicle)
  private engineOsc1: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private engineNoiseFilter: BiquadFilterNode | null = null;
  private engineNoiseGain: GainNode | null = null;
  private engineActive = false;
  /** Last gear `rpmFromSpeed` chose for the player's engine, fed back in for hysteretic shifting. */
  private engineGear = -1;

  // ambient bed + rain
  private rainGain: GainNode | null = null;
  private rainActive = false;

  // tyre screech
  private screechFilter: BiquadFilterNode | null = null;
  private screechGainNode: GainNode | null = null;
  private screechActive = false;

  // police siren
  private sirenOsc: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;
  private sirenActive = false;

  // pooled traffic engines
  private trafficVoices: TrafficSlot[] = [];
  private trafficBudget = TRAFFIC_VOICE_POOL_SIZE;

  // horn (transient): a count, not a flag — two overlapping bursts must not have the first one's
  // `onended` clear the second one's voice.
  private hornVoices = 0;

  // crash (transient, rate-limited)
  private lastCrashTime = -Infinity;
  private crashActiveUntil = -Infinity;

  /** Whether the `AudioContext` has been created (i.e. a real gesture has happened). */
  get started(): boolean {
    return this.startedFlag;
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  get snapshot(): AudioSnapshot {
    return { started: this.startedFlag, muted: this.mutedFlag, voices: this.countVoices(), contextState: this.ctx?.state ?? null };
  }

  /**
   * Register one-shot listeners on `target` that create the `AudioContext` on the first real
   * key/pointer/touch event — never before. Safe to call with `null`/a non-DOM target (no-op).
   */
  attachGestureListeners(target: EventTarget | null | undefined): void {
    if (!target || typeof target.addEventListener !== 'function') return;
    this.gestureTarget = target;
    const opts: AddEventListenerOptions = { once: true, passive: true };
    safely(() => target.addEventListener('keydown', this.onGesture, opts));
    safely(() => target.addEventListener('pointerdown', this.onGesture, opts));
    safely(() => target.addEventListener('touchstart', this.onGesture, opts));
  }

  private removeGestureListeners(): void {
    const target = this.gestureTarget;
    if (!target) return;
    safely(() => target.removeEventListener('keydown', this.onGesture));
    safely(() => target.removeEventListener('pointerdown', this.onGesture));
    safely(() => target.removeEventListener('touchstart', this.onGesture));
    this.gestureTarget = null;
  }

  /**
   * Create the `AudioContext` and build the node graph. Idempotent, and a safe no-op if WebAudio is
   * unavailable or construction throws (headless/test runners, or a browser without the API). Also
   * called directly by `attachGestureListeners`'s handlers; exposed so a caller can force it, though
   * normal play only ever reaches it via a real gesture.
   */
  start(): void {
    this.removeGestureListeners();
    if (this.startedFlag || !this.supported) return;
    const ok = safely(() => this.build());
    if (!ok) {
      this.supported = false;
      // `build()` may have thrown *after* constructing the context; close it rather than leaking a
      // live audio device for the lifetime of the page.
      const half = this.ctx;
      this.ctx = null;
      if (half) safely(() => void half.close().catch(() => {}));
      return;
    }
    this.startedFlag = true;
    safely(() => {
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    });
  }

  private build(): boolean {
    const w = typeof window !== 'undefined' ? window : undefined;
    const Ctor: typeof AudioContext | undefined = w?.AudioContext ?? (w as unknown as { webkitAudioContext?: typeof AudioContext } | undefined)?.webkitAudioContext;
    if (!Ctor) return false;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.masterTarget();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_THRESHOLD_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    this.master.connect(limiter).connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0; // no music track yet; present for the master/music/sfx bus shape
    this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);

    this.noiseBuffer = this.buildNoiseBuffer(ctx);
    this.buildAmbient(ctx);
    this.buildEngine(ctx);
    this.buildScreech(ctx);
    this.buildSiren(ctx);
    this.buildTrafficPool(ctx);
    return true;
  }

  private buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_BUFFER_SECONDS));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic (the project's own `Random`, never `Math.random()` — see AGENT_GUIDE/
    // ARCHITECTURE): the exact noise texture doesn't matter, but the "no Math.random() outside
    // Random" rule doesn't carve out an exception for cosmetic audio either.
    const rng = new Random(0x4a17e5);
    for (let i = 0; i < length; i++) data[i] = rng.next() * 2 - 1;
    return buffer;
  }

  private loopedNoise(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    return src;
  }

  /** City-hum ambient bed (always on once started) plus a rain noise bed scaled by wetness. */
  private buildAmbient(ctx: AudioContext): void {
    const hum = this.loopedNoise(ctx);
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 300;
    const humGain = ctx.createGain();
    humGain.gain.value = AMBIENT_GAIN;
    hum.connect(humFilter).connect(humGain).connect(this.sfxBus!);
    hum.start();

    const rain = this.loopedNoise(ctx);
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'highpass';
    rainFilter.frequency.value = 1800;
    const rainGain = ctx.createGain();
    rainGain.gain.value = 0;
    rain.connect(rainFilter).connect(rainGain).connect(this.sfxBus!);
    rain.start();
    this.rainGain = rainGain;
  }

  /** Two detuned oscillators (sawtooth + square) plus low-passed noise, both lowpass-filtered and
   *  swept by RPM (`rpmFromSpeed`). */
  private buildEngine(ctx: AudioContext): void {
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 40;
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 40;
    osc2.detune.value = 9;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain).connect(this.sfxBus!);
    osc1.start();
    osc2.start();

    const noise = this.loopedNoise(ctx);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 500;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noise.connect(noiseFilter).connect(noiseGain).connect(this.sfxBus!);
    noise.start();

    this.engineOsc1 = osc1;
    this.engineOsc2 = osc2;
    this.engineFilter = filter;
    this.engineGain = gain;
    this.engineNoiseFilter = noiseFilter;
    this.engineNoiseGain = noiseGain;
  }

  /** Band-passed noise whose gain follows `screechGain` (lateral speed + handbrake). */
  private buildScreech(ctx: AudioContext): void {
    const noise = this.loopedNoise(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value = 6;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    noise.connect(filter).connect(gain).connect(this.sfxBus!);
    noise.start();
    this.screechFilter = filter;
    this.screechGainNode = gain;
  }

  /** Alternating two-tone siren (`sirenFrequency`), gained by `distanceAttenuation`. */
  private buildSiren(ctx: AudioContext): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = SIREN_LOW_HZ; // initial value; updated every tick from `sirenFrequency`
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(this.sfxBus!);
    osc.start();
    this.sirenOsc = osc;
    this.sirenGain = gain;
  }

  /** Fixed pool of quiet triangle-wave engine voices for the nearest traffic cars. */
  private buildTrafficPool(ctx: AudioContext): void {
    const voices: TrafficSlot[] = [];
    for (let i = 0; i < TRAFFIC_VOICE_POOL_SIZE; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 60;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 500;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(this.sfxBus!);
      osc.start();
      voices.push({ osc, gain, active: false, gear: -1 });
    }
    this.trafficVoices = voices;
  }

  private masterTarget(): number {
    return this.mutedFlag || this.pausedFlag ? 0 : MASTER_GAIN;
  }

  /** Ramp (rather than jump) the master bus to its current target, so muting/pausing doesn't click. */
  private applyMasterGain(): void {
    safely(() => {
      if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.masterTarget(), this.ctx.currentTime, 0.02);
    });
  }

  setMuted(muted: boolean): void {
    if (muted === this.mutedFlag) return;
    this.mutedFlag = muted;
    this.applyMasterGain();
  }

  toggleMute(): void {
    this.setMuted(!this.mutedFlag);
  }

  /** Silence everything while the game is paused (the settings menu is open) without disturbing the
   *  mute state the player chose. Idempotent — cheap to call every tick. */
  setPaused(paused: boolean): void {
    if (paused === this.pausedFlag) return;
    this.pausedFlag = paused;
    this.applyMasterGain();
  }

  /** Cap on how many of the (fixed-size) traffic voice pool are actually assigned a car this tick —
   *  driven by the quality preset's `audioTrafficVoices` (cheaper on `low`). */
  setTrafficBudget(n: number): void {
    // `Number.isFinite` first: a settings record saved before `audioTrafficVoices` existed could
    // hand us `undefined`, and `Math.min(4, NaN)` is NaN (silently disabling the pool).
    this.trafficBudget = Number.isFinite(n) ? Math.max(0, Math.min(TRAFFIC_VOICE_POOL_SIZE, Math.floor(n))) : TRAFFIC_VOICE_POOL_SIZE;
  }

  /** Fixed-step update — call once per `Game.update(dt)` tick regardless of whether audio has
   *  started; a safe no-op until it has. */
  update(input: AudioUpdateInput): void {
    if (!this.startedFlag || !this.ctx) return;
    safely(() => this.doUpdate(input));
  }

  private doUpdate(input: AudioUpdateInput): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    this.engineActive = input.driving;
    if (this.engineGain && this.engineNoiseGain && this.engineOsc1 && this.engineOsc2 && this.engineFilter) {
      if (input.driving) {
        const { rpm, gear } = rpmFromSpeed(input.speed, input.throttle, undefined, this.engineGear);
        this.engineGear = gear;
        const freq = 30 + rpm * 190;
        this.engineOsc1.frequency.setTargetAtTime(freq, now, RAMP);
        this.engineOsc2.frequency.setTargetAtTime(freq * 1.005, now, RAMP);
        this.engineFilter.frequency.setTargetAtTime(500 + rpm * 3500, now, RAMP);
        const vol = ENGINE_GAIN * (0.35 + 0.65 * rpm);
        this.engineGain.gain.setTargetAtTime(vol, now, RAMP);
        this.engineNoiseGain.gain.setTargetAtTime(vol * 0.5, now, RAMP);
      } else {
        this.engineGear = -1;
        this.engineGain.gain.setTargetAtTime(0, now, RAMP);
        this.engineNoiseGain.gain.setTargetAtTime(0, now, RAMP);
      }
    }

    const screech = input.driving ? screechGain(input.lateralSpeed, input.handbrake) : 0;
    this.screechActive = screech > 0.02;
    if (this.screechGainNode) this.screechGainNode.gain.setTargetAtTime(screech * SCREECH_GAIN_SCALE, now, RAMP);

    this.rainActive = clamp01(input.wetness) > 0.03;
    if (this.rainGain) this.rainGain.gain.setTargetAtTime(clamp01(input.wetness) * RAIN_GAIN_SCALE, now, 0.5);

    const pursuing = input.pursuing && Number.isFinite(input.policeDistance);
    this.sirenActive = pursuing;
    if (this.sirenOsc && this.sirenGain) {
      if (pursuing) {
        this.sirenOsc.frequency.setValueAtTime(sirenFrequency(input.simTime), now);
        const atten = distanceAttenuation(input.policeDistance, SIREN_MAX_DISTANCE);
        this.sirenGain.gain.setTargetAtTime(atten * SIREN_GAIN, now, RAMP);
      } else {
        this.sirenGain.gain.setTargetAtTime(0, now, RAMP);
      }
    }

    this.updateTraffic(input.traffic, now);
  }

  private updateTraffic(traffic: readonly TrafficVoiceSample[], now: number): void {
    const slots = this.trafficVoices;
    const budget = Math.min(this.trafficBudget, slots.length, traffic.length);
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      const car = i < budget ? traffic[i] : undefined;
      if (!car || !(car.distance < Infinity)) {
        slot.active = false;
        slot.gear = -1;
        slot.gain.gain.setTargetAtTime(0, now, RAMP);
        continue;
      }
      slot.active = true;
      const { rpm, gear } = rpmFromSpeed(car.speed, car.speed > 0.5 ? 0.4 : 0, undefined, slot.gear);
      slot.gear = gear;
      slot.osc.frequency.setTargetAtTime(35 + rpm * 90, now, RAMP);
      const atten = distanceAttenuation(car.distance, TRAFFIC_MAX_DISTANCE);
      slot.gain.gain.setTargetAtTime(atten * TRAFFIC_GAIN, now, RAMP);
    }
  }

  /** Two-tone horn burst on `InputState.hornPressed`. Safe no-op before `start()`. */
  playHorn(): void {
    if (!this.startedFlag || !this.ctx || !this.sfxBus) return;
    safely(() => {
      const ctx = this.ctx!;
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(HORN_GAIN, now + 0.02);
      gain.gain.setValueAtTime(HORN_GAIN, Math.max(now + 0.02, now + HORN_DURATION_S - 0.05));
      gain.gain.linearRampToValueAtTime(0, now + HORN_DURATION_S);
      gain.connect(this.sfxBus!);
      const o1 = ctx.createOscillator();
      o1.type = 'square';
      o1.frequency.value = 400;
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = 500;
      o1.connect(gain);
      o2.connect(gain);
      o1.start(now);
      o2.start(now);
      const stopAt = now + HORN_DURATION_S + 0.02;
      o1.stop(stopAt);
      o2.stop(stopAt);
      this.hornVoices++;
      o1.onended = () => {
        this.hornVoices = Math.max(0, this.hornVoices - 1);
        safely(() => {
          o1.disconnect();
          o2.disconnect();
          gain.disconnect();
        });
      };
    });
  }

  /**
   * Crash thud: a short filtered noise burst, amplitude proportional to the collision impulse
   * (`crashAmplitude`), rate-limited so several contacts in the same bounce read as one crash.
   */
  playCrash(impulse: number): void {
    if (!this.startedFlag || !this.ctx || !this.sfxBus || !this.noiseBuffer) return;
    const amp = crashAmplitude(impulse);
    if (amp <= 0) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (now - this.lastCrashTime < CRASH_COOLDOWN_S) return;
    this.lastCrashTime = now;
    safely(() => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 220 + amp * 500;
      const gain = ctx.createGain();
      const peak = amp * CRASH_GAIN_SCALE;
      gain.gain.setValueAtTime(peak, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak * 0.02), now + 0.28);
      src.connect(filter).connect(gain).connect(this.sfxBus!);
      const stopAt = now + 0.32;
      src.start(now);
      src.stop(stopAt);
      this.crashActiveUntil = stopAt;
      src.onended = () =>
        safely(() => {
          src.disconnect();
          filter.disconnect();
          gain.disconnect();
        });
    });
  }

  private countVoices(): number {
    if (!this.startedFlag) return 0;
    let n = 1; // the ambient city-hum bed is always on once started
    if (this.rainActive) n++;
    if (this.engineActive) n++;
    if (this.screechActive) n++;
    if (this.sirenActive) n++;
    if (this.hornVoices > 0) n++;
    if (this.ctx && this.ctx.currentTime < this.crashActiveUntil) n++;
    for (const slot of this.trafficVoices) if (slot.active) n++;
    return n;
  }

  dispose(): void {
    this.removeGestureListeners();
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.ctx = null;
    this.startedFlag = false;
    this.hornVoices = 0;
    this.engineGear = -1;
    safely(() => void ctx.close().catch(() => {}));
  }
}
