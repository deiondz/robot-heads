/* Sound for a head, played on its cues: each state keeps a beat for as
   long as it lasts, and sleeping loops a sound that breathes with the bob.
   Loaded on demand, the first time a head turns sound on. */

import type { RobotHeadCue, RobotHeadSound, RobotHeadSoundOptions, RobotHeadState } from '../types';
import * as assets from './assets';

interface Voice {
  src: string;
  volume: number;
}

const BUILT_IN: Record<Exclude<RobotHeadSound, 'sleeping'>, Voice> = {
  idle: { src: assets.tick, volume: 0.12 },
  thinking: { src: assets.question, volume: 0.35 },
  searching: { src: assets.scroll, volume: 0.2 },
  listening: { src: assets.maximize, volume: 0.3 },
  speaking: { src: assets.pluck, volume: 0.3 },
  working: { src: assets.tickSoft, volume: 0.12 },
  happy: { src: assets.pep, volume: 0.3 },
  error: { src: assets.errorBuzz, volume: 0.4 },
  hop: { src: assets.jump, volume: 0.5 },
  land: { src: assets.drop, volume: 0.25 },
  switch: { src: assets.glitch, volume: 0.35 },
  asleep: { src: assets.phaserDown, volume: 0.45 },
  awake: { src: assets.phaserUp, volume: 0.45 },
};

/* the bar filling in the working state, when its beat is the built-in tick */
const FILLED: Voice = { src: assets.confirmation, volume: 0.3 };

/* the purr, by default, while it sleeps: its own chunk, loaded on first need */
const SLEEPING_VOLUME = 0.35;
let purr: string | null = null;
let purrLoading = false;

function builtInPurr(): string | null {
  if (!purr && !purrLoading) {
    purrLoading = true;
    import('./purr').then(
      (m) => {
        purr = m.purr;
      },
      () => {
        purrLoading = false;
      }
    );
  }
  return purr;
}

/* the sleeping loop's swell: quieter on the in-breath */
const BREATH_IN = 0.6;
/* skip an MP3's encoder padding at each end, or the loop clicks */
const TRIM = 0.05;

let shared: AudioContext | null = null;

function context(): AudioContext | null {
  if (shared) return shared;
  if (typeof AudioContext === 'undefined' || typeof document === 'undefined') return null;
  const ctx = (shared = new AudioContext());
  const resume = () => {
    if (!document.hidden && ctx.state === 'suspended') ctx.resume().catch(() => {});
  };
  /* audio unlocks on a gesture; the context may have been made before one */
  for (const type of ['pointerdown', 'keydown'] as const) document.addEventListener(type, resume, { capture: true, passive: true });
  /* the animation loop stops on a hidden tab, so the sound does too */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) ctx.suspend().catch(() => {});
    else resume();
  });
  return ctx;
}

/* decoded once per page; data URIs decoded in place, so no fetch (or CSP) */
const buffers = new Map<string, AudioBuffer | Promise<AudioBuffer | null>>();

function bytes(src: string): Promise<ArrayBuffer> {
  if (!src.startsWith('data:')) return fetch(src).then((r) => r.arrayBuffer());
  const raw = atob(src.slice(src.indexOf(',') + 1));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return Promise.resolve(out.buffer);
}

function load(ctx: AudioContext, src: string): Promise<AudioBuffer | null> {
  const known = buffers.get(src);
  if (known) return Promise.resolve(known);
  const loading = bytes(src)
    .then((data) => ctx.decodeAudioData(data))
    .then((buffer) => {
      buffers.set(src, buffer);
      return buffer;
    })
    .catch(() => {
      buffers.delete(src);
      return null;
    });
  buffers.set(src, loading);
  return loading;
}

/* a decoded buffer, or null while it loads */
function ready(ctx: AudioContext, src: string): AudioBuffer | null {
  const known = buffers.get(src);
  if (known instanceof AudioBuffer) return known;
  if (!known) load(ctx, src);
  return null;
}

interface Loop {
  src: string;
  source: AudioBufferSourceNode;
  breath: GainNode;
  fade: GainNode;
}

export class SoundPlayer {
  options: RobotHeadSoundOptions = {};
  private loop: Loop | null = null;

  constructor() {
    const ctx = context();
    /* decode the set up front, so the first beat of each isn't missed */
    if (ctx) for (const voice of [...Object.values(BUILT_IN), FILLED]) load(ctx, voice.src);
  }

  private voice(sound: RobotHeadSound): Voice | null {
    const swap = this.options.sounds?.[sound];
    if (swap === false) return null;
    if (sound === 'sleeping') {
      /* null while the purr loads; the loop starts on a later frame */
      const src = swap || builtInPurr();
      return src ? { src, volume: SLEEPING_VOLUME } : null;
    }
    const built = BUILT_IN[sound];
    return swap ? { src: swap, volume: built.volume } : built;
  }

  private get volume() {
    const v = this.options.volume ?? 1;
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  }

  private play(voice: Voice | null, scale = 1, rate = 1) {
    const ctx = context();
    /* before the first gesture the context can't start: drop the beat
       rather than queue it, or the first click would set them all off */
    if (!voice || !ctx || ctx.state !== 'running') return;
    const buffer = ready(ctx, voice.src);
    if (!buffer) return;
    const source = new AudioBufferSourceNode(ctx, { buffer, playbackRate: rate });
    source.connect(new GainNode(ctx, { gain: voice.volume * scale * this.volume })).connect(ctx.destination);
    source.start();
  }

  cue(cue: RobotHeadCue, state: RobotHeadState) {
    switch (cue.type) {
      case 'state':
        this.play(this.voice('switch'));
        if (cue.previous === 'sleeping') this.play(this.voice('awake'));
        if (cue.state === 'sleeping') this.play(this.voice('asleep'));
        break;
      case 'hop':
        /* happy's beat is its bounce; elsewhere a hop it does itself is quieter than a click's */
        if (state === 'happy') this.play(this.voice('happy'));
        else this.play(this.voice('hop'), cue.poked ? 1 : 0.4);
        break;
      case 'land':
        this.play(this.voice('land'));
        break;
      case 'beat': {
        if (cue.state === 'working' && cue.accent && !this.options.sounds?.working) {
          this.play(FILLED);
          break;
        }
        /* speech: each syllable pitched a little differently, stressed ones louder and higher */
        const speech = cue.state === 'speaking';
        const rate = speech ? 0.85 + Math.random() * 0.5 + (cue.accent ? 0.15 : 0) : 1;
        this.play(this.voice(cue.state), speech && cue.accent ? 1.3 : 1, rate);
        break;
      }
      case 'breath':
        if (this.loop) this.loop.breath.gain.setTargetAtTime(cue.out ? 1 : BREATH_IN, this.loop.breath.context.currentTime, 0.6);
        break;
    }
  }

  /** Every frame: whether the sleeping loop should run. */
  setLoop(on: boolean) {
    const voice = on ? this.voice('sleeping') : null;
    const loop = this.loop;
    if (loop && (!voice || loop.src !== voice.src)) this.stopLoop();
    if (!voice) return;
    const ctx = context();
    if (!ctx) return;
    if (this.loop) {
      this.loop.fade.gain.setTargetAtTime(voice.volume * this.volume, ctx.currentTime, 0.5);
      return;
    }
    const buffer = ready(ctx, voice.src);
    if (!buffer) return;
    const breath = new GainNode(ctx, { gain: (1 + BREATH_IN) / 2 });
    const fade = new GainNode(ctx, { gain: 0 });
    const end = Math.max(TRIM * 2, buffer.duration - TRIM);
    const source = new AudioBufferSourceNode(ctx, { buffer, loop: true, loopStart: TRIM, loopEnd: end });
    source.connect(breath).connect(fade).connect(ctx.destination);
    source.start(0, TRIM);
    fade.gain.setTargetAtTime(voice.volume * this.volume, ctx.currentTime, 0.5);
    this.loop = { src: voice.src, source, breath, fade };
  }

  private stopLoop() {
    const loop = this.loop;
    if (!loop) return;
    this.loop = null;
    loop.fade.gain.setTargetAtTime(0, loop.fade.context.currentTime, 0.15);
    /* each loop lets go on its own clock, so a quick restart can't strand one */
    setTimeout(() => {
      loop.source.stop();
      loop.fade.disconnect();
    }, 700);
  }

  dispose() {
    const loop = this.loop;
    this.loop = null;
    loop?.source.stop();
    loop?.fade.disconnect();
  }
}
