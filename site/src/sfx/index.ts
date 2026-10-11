/* The stage head's sound effects: soundcn's CC0 sounds (lib/ and sounds/,
   vendored from soundcn.xyz) on the head's cues, and a purr looped while
   it sleeps. */

import type { RobotHeadCue, RobotHeadState } from 'robot-heads';
import { getAudioContext, playSound } from './lib/sound-engine';
import type { SoundAsset } from './lib/sound-types';
import { drop003Sound } from './sounds/drop-003';
import { errorBuzzSound } from './sounds/error-buzz';
import { glitch003Sound } from './sounds/glitch-003';
import { jinglesNes15Sound } from './sounds/jingles-nes-15';
import { jump8bitSound } from './sounds/jump-8bit';
import { maximize008Sound } from './sounds/maximize-008';
import { phaserDown3Sound } from './sounds/phaser-down-3';
import { phaserUp3Sound } from './sounds/phaser-up-3';
import { question003Sound } from './sounds/question-003';

let enabled = true;
let listening = false;

/* audio unlocks on a gesture, and goes quiet with the tab */
function listen() {
  if (listening) return;
  listening = true;
  const resume = () => {
    const ctx = getAudioContext();
    if (!document.hidden && ctx.state === 'suspended') ctx.resume().catch(() => {});
  };
  for (const type of ['pointerdown', 'keydown'] as const) document.addEventListener(type, resume, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) getAudioContext().suspend().catch(() => {});
    else resume();
  });
}

export function setSfxEnabled(on: boolean) {
  enabled = on;
  if (!on) purr.stop();
}

function play(sound: SoundAsset, volume: number) {
  if (!enabled) return;
  listen();
  /* before the first gesture the context can't start: drop the sound
     rather than queue it, or the first click would set them all off */
  if (getAudioContext().state !== 'running') return;
  playSound(sound.dataUri, { volume }).catch(() => {});
}

const ENTER: Partial<Record<RobotHeadState, SoundAsset>> = {
  sleeping: phaserDown3Sound,
  happy: jinglesNes15Sound,
  error: errorBuzzSound,
  thinking: question003Sound,
  listening: maximize008Sound,
};

/** Hand the stage head's `onCue` straight to this. */
export function cue(c: RobotHeadCue) {
  switch (c.type) {
    case 'state': {
      /* the screen glitches on every switch; so does the sound */
      play(glitch003Sound, 0.4);
      if (c.previous === 'sleeping') play(phaserUp3Sound, 0.5);
      const enter = ENTER[c.state];
      if (enter) play(enter, 0.5);
      break;
    }
    case 'hop':
      /* happy bounces about once a second, so the ones it does itself stay quiet */
      play(jump8bitSound, c.poked ? 0.6 : 0.2);
      break;
    case 'land':
      play(drop003Sound, 0.25);
      break;
    case 'breath':
      purr.breathe(c.out);
      break;
  }
}

/* the purr: a recording, looped, swelling on each out-breath */
const PURR_URL = '/sfx/cat-purring.mp3';
/* skip the MP3's encoder padding at each end, or the loop clicks */
const TRIM = 0.05;
const PURR_IN = 0.18;
const PURR_OUT = 0.35;

let purrBuffer: Promise<AudioBuffer> | null = null;
const loadPurr = () =>
  (purrBuffer ??= fetch(PURR_URL)
    .then((r) => r.arrayBuffer())
    .then((data) => getAudioContext().decodeAudioData(data))
    .catch((err) => {
      purrBuffer = null;
      throw err;
    }));

interface Voice {
  source: AudioBufferSourceNode;
  breath: GainNode;
  fade: GainNode;
}

let voice: Voice | null = null;
let wanted = false;
let release: ReturnType<typeof setTimeout> | undefined;

export const purr = {
  start() {
    if (wanted || !enabled) return;
    wanted = true;
    listen();
    clearTimeout(release);
    const ctx = getAudioContext();
    if (voice) {
      voice.fade.gain.setTargetAtTime(1, ctx.currentTime, 0.5);
      return;
    }
    loadPurr()
      .then((buffer) => {
        if (!wanted || voice) return;
        const source = new AudioBufferSourceNode(ctx, { buffer, loop: true, loopStart: TRIM, loopEnd: buffer.duration - TRIM });
        const breath = new GainNode(ctx, { gain: (PURR_IN + PURR_OUT) / 2 });
        const fade = new GainNode(ctx, { gain: 0 });
        source.connect(breath).connect(fade).connect(ctx.destination);
        source.start(0, TRIM);
        fade.gain.setTargetAtTime(1, ctx.currentTime, 0.5);
        voice = { source, breath, fade };
      })
      .catch(() => {});
  },

  stop() {
    if (!wanted) return;
    wanted = false;
    const v = voice;
    if (!v) return;
    v.fade.gain.setTargetAtTime(0, v.fade.context.currentTime, 0.15);
    release = setTimeout(() => {
      v.source.stop();
      v.fade.disconnect();
      if (voice === v) voice = null;
    }, 700);
  },

  breathe(out: boolean) {
    voice?.breath.gain.setTargetAtTime(out ? PURR_OUT : PURR_IN, voice.breath.context.currentTime, 0.6);
  },
};
