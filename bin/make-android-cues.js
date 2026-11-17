#!/usr/bin/env node
// The Android client ships three cue packs, but only one of them can be a
// download: `res/raw/{sent,received,wake}.mp3` are the Mixkit samples the web
// client plays (`web/cloud/sounds`), and there is no free-licence pair that
// matches them for the other two packs without adding a third-party asset and
// its credits to the repo. So the other two packs are *synthesised* here, from
// arithmetic: a soft sine chime and a terminal blip, written straight as
// 16-bit mono 44.1 kHz PCM WAV. Nothing is downloaded, nothing is decoded, and
// the bytes are deterministic — running this twice produces identical files, so
// it is safe to re-run and diff.
//
// Two constraints shape every number below:
//  * `res/raw` lands uncompressed in the APK, so each cue is budgeted 40 KB —
//    at 44.1 kHz/16-bit mono that is ~460 ms of audio, and it is the duration
//    ceiling that actually binds (see MAX_BYTES / assertBudget).
//  * SoundPool sums concurrent streams, so a cue peaking at full scale clips as
//    soon as a backlog plays two of them. Everything is normalised to PEAK.
//
// Two files in that directory are NOT written here: `call_ringback.wav` (the
// caller's ringback) and `call_ring_phone.wav` (the default ring) are
// recordings the owner supplied and asked for by ear. They are masters under
// `assets/sounds/`, cut into raw resources once — see that directory's
// CREDITS.txt for the derivation and the provenance — and this script prints a
// reminder and leaves them alone.
//
// Usage: node bin/make-android-cues.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'android/app/src/main/res/raw');

const SAMPLE_RATE = 44100;
const PEAK = 0.5;
const MAX_BYTES = 40 * 1024;
const MAX_MS = 700;

const frames = (ms) => Math.round((ms / 1000) * SAMPLE_RATE);

const sine = (phase) => Math.sin(2 * Math.PI * phase);
const square = (phase) => ((phase % 1) < 0.5 ? 1 : -1);
const triangle = (phase) => {
  const t = phase % 1;
  return t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
};

// Both envelopes reach exactly 0 at the last frame and rise from 0 at the
// first: a square wave cut mid-period is a click, and a click is what makes a
// synthesised cue sound broken rather than short.
const ENVELOPES = {
  // Struck-and-ringing: fast attack, exponential ring-out folded with (1 - p)
  // so the tail is silent instead of merely quiet.
  chime: (p) => Math.exp(-3.4 * p) * (1 - p),
  // A tick has to read as one event, so it holds level and then falls off over
  // the last third on a cosine ramp.
  blip: (p) => (p < 0.66 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (p - 0.66)) / 0.34)),
  // Held flat: the shape of a network tone, which is switched on and off
  // rather than struck. Its ramps come from `attackMs`/`releaseMs`, not from
  // the level curve — a tone that decays over its last third is a beep, and a
  // beep is not what a phone network sends back.
  gate: () => 1,
};

/** One note: `wave` sampled at `freq`, shaped by `envelope`, as floats. */
function note({ freq, ms, wave, envelope, attackMs, releaseMs = 0 }) {
  const total = frames(ms);
  const attack = Math.max(1, frames(attackMs));
  const release = Math.max(0, frames(releaseMs));
  const shape = ENVELOPES[envelope];
  const out = new Float64Array(total);
  for (let i = 0; i < total; i += 1) {
    const rise = i < attack ? 0.5 - 0.5 * Math.cos((Math.PI * i) / attack) : 1;
    // Symmetrical to `rise` and reaching exactly 0 on the last frame: a gated
    // tone cut mid-period is a click.
    let fall = 1;
    if (release > 0) {
      const remaining = total - 1 - i;
      if (remaining < release) fall = 0.5 - 0.5 * Math.cos((Math.PI * remaining) / release);
    }
    const rest = total - attack;
    const p = rest > 0 ? Math.min(1, Math.max(0, (i - attack) / rest)) : 1;
    out[i] = wave((freq * i) / SAMPLE_RATE) * rise * fall * shape(p);
  }
  return out;
}

/** Notes and gaps laid end to end, then scaled so the loudest frame is `peak`.
 *  The ceiling is a parameter because two of these sounds are held to the ear
 *  rather than meant to cut through a room — see `CUE_PEAK`. */
function render(parts, peak = PEAK) {
  const rendered = parts.map((part) =>
    part.gapMs === undefined ? note(part) : new Float64Array(frames(part.gapMs)),
  );
  const total = rendered.reduce((sum, chunk) => sum + chunk.length, 0);
  const mix = new Float64Array(total);
  let at = 0;
  for (const chunk of rendered) {
    mix.set(chunk, at);
    at += chunk.length;
  }
  let loudest = 0;
  for (const value of mix) loudest = Math.max(loudest, Math.abs(value));
  const gain = loudest > 0 ? peak / loudest : 0;
  for (let i = 0; i < mix.length; i += 1) mix[i] *= gain;
  return mix;
}

/** Canonical 44-byte RIFF header plus little-endian signed 16-bit frames. */
function wav(samples) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // WAVE_FORMAT_PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    // 32767, not 32768: -32768 has no positive twin, and rounding a normalised
    // +PEAK frame up past the maximum wraps it to a full-scale negative spike.
    const value = Math.round(samples[i] * 32767);
    buffer.writeInt16LE(Math.min(32767, Math.max(-32767, value)), 44 + i * 2);
  }
  return buffer;
}

const chime = (freq, ms) => ({ freq, ms, wave: sine, envelope: 'chime', attackMs: 8 });
const tick = (freq, ms, wave) => ({ freq, ms, wave, envelope: 'blip', attackMs: 1.5 });
const gap = (gapMs) => ({ gapMs });

// The `soft` pack's incoming cue, the one a notification plays. A bare sine
// reads as a test tone on a phone speaker — the first version of this cue was
// two of them, 660→880 Hz with an 8 ms attack, and the owner called it strange.
// A single octave partial gives the tone a body, and a 16 ms attack is the
// difference between a note being struck and a note being switched on.
const warm = (phase) => 0.86 * sine(phase) + 0.14 * sine(phase * 2);
const softNote = (freq, ms) => ({ freq, ms, wave: warm, envelope: 'chime', attackMs: 16 });

// Raw resource names are Java identifiers: lowercase a-z0-9_ only, or aapt2
// refuses the whole build. `soft_`/`term_` mirror SoundPack.Soft/Terminal in
// android/app/src/main/java/net/tailchat/android/Settings.kt.
const CUES = {
  // A two-note rise is "something arrived"; the same rising fourth the web
  // client's marimba cue walks, an octave down and with a warm voice, so the
  // packs are interchangeable events rather than interchangeable sounds.
  soft_received: [softNote(440, 180), gap(20), softNote(587.33, 225)],
  soft_sent: [chime(520, 150)],
  soft_wake: [chime(660, 110), gap(15), chime(880, 110), gap(15), chime(1174, 140)],
  term_received: [tick(1000, 38, square), gap(52), tick(1000, 38, square)],
  term_sent: [tick(700, 45, square)],
  term_wake: [
    tick(1200, 32, triangle),
    gap(44),
    tick(1200, 32, triangle),
    gap(44),
    tick(1200, 32, triangle),
  ],
};

// The incoming-call ringtone. Not a cue: it is played on loop by
// `CallRinger` for the whole 45-second ring window, so it is a phrase with a
// tail of silence rather than a single event, and it gets its own budget —
// the 40 KB/700 ms cue ceiling is about SoundPool cues, and this is a
// MediaPlayer stream. Same rule as the packs above: synthesised, so there is
// no third-party asset or credit line in the repo.
//
// The default melody is a wooden-mallet motif, not a bell: the bell phrase
// this replaces (three struck sines with a 2.76× inharmonic partial) was the
// one the owner asked to change. A marimba-like voice is a strong odd
// harmonic with almost nothing between — percussive attack, short wooden
// decay — and the phrase is a six-note figure that turns back on itself,
// which reads as a ringtone rather than as a notification chime.
//
// Softened once more on the owner's second pass («более мягкий и приятный»):
// the partials moved from 4×/6.35× down to 3×/5.4×, which is the difference
// between a mallet struck on a hard bar and the same mallet on a wooden one,
// and the strike itself is no longer instantaneous — 14 ms instead of 4, the
// same "note struck versus note switched on" line the cues are built around.
const marimbaWave = (phase) =>
  0.78 * sine(phase) + 0.16 * sine(phase * 3) + 0.06 * sine(phase * 5.4);
const mallet = (freq, ms) => ({ freq, ms, wave: marimbaWave, envelope: 'chime', attackMs: 14 });

// The two alternatives the settings sheet offers next to the default. Three
// choices, one file each: the melody is a `MediaPlayer` resource picked by
// `AppPreferences.callRingtone`, so adding one is adding a name here and a
// case in `CallRingtone`.
//
// `classic` is the analogue telephone ring: 440 Hz and 480 Hz sounded
// together beat at 40 Hz, which is the warble everyone recognises, in the
// North-American cadence (two seconds of ring, four of silence — halved here
// because the file loops).
const warbleWave = (phase) => 0.5 * sine(phase) + 0.5 * sine(phase * (480 / 440));
const warble = (ms) => ({ freq: 440, ms, wave: warbleWave, envelope: 'blip', attackMs: 25 });
// `pulse` is the opposite brief: a short digital arpeggio, no ring-out, for
// somebody who wants the phone to sound like a device and not like a bell.
const pulse = (freq, ms) => ({ freq, ms, wave: triangle, envelope: 'blip', attackMs: 4 });

const RING_MAX_BYTES = 400 * 1024;
const RING_MAX_MS = 4000;
const RINGTONE = {
  // E5 → B5 → G#5 → C#6 → B5, then a rest long enough that the loop
  // breathes instead of hammering. The last note is the longest: it is the
  // one still sounding when the figure starts again. Notes and the rest grew
  // together on the owner's softening pass — the figure is the same, it is
  // simply no longer in a hurry.
  call_ring_chime: [
    mallet(659, 240),
    gap(40),
    mallet(988, 240),
    gap(40),
    mallet(831, 240),
    gap(40),
    mallet(1109, 240),
    gap(40),
    mallet(988, 520),
    gap(820),
  ],
  // Option two: the recognisable analogue warble.
  call_ring_classic: [
    warble(900),
    gap(220),
    warble(900),
    gap(1400),
  ],
  // Option three: four rising blips, nothing ringing on after them.
  call_ring_pulse: [
    pulse(988, 90),
    gap(60),
    pulse(1175, 90),
    gap(60),
    pulse(1319, 90),
    gap(60),
    pulse(1568, 130),
    gap(900),
  ],
  // `call_ringback` is deliberately NOT in this table any more. The owner
  // supplied the sound he wanted for it — an old telephone bell, recorded — and
  // a shipped asset has no business being overwritten by a synthesiser on the
  // next run (the loop below writes every key it finds here, and would have
  // reported the owner's file as "updated"). The file in `res/raw` is cut from
  // `assets/sounds/old-phone-ring.mp3`: one 1.15 s bell burst, peak-normalised
  // to 0.34, padded with silence to 3.8 s so the loop keeps the network's
  // cadence. `assets/sounds/CREDITS.txt` carries the derivation and where the
  // recording came from.
};

// Where the shared PEAK is the wrong ceiling. `render` normalises to the
// loudest frame, so "softer" cannot come from turning a file down — it has to
// be a different ceiling here *and* a gentler voice above. This is the one the
// owner asked to soften: the ringtone. Everything else keeps PEAK, because a
// notification cue has to cut through a room.
const CUE_PEAK = {
  call_ring_chime: 0.4,
};

function assertBudget(name, bytes, ms) {
  if (bytes.length > MAX_BYTES) {
    throw new Error(`${name}.wav is ${bytes.length} B, over the ${MAX_BYTES} B raw-resource budget`);
  }
  if (ms > MAX_MS) {
    throw new Error(`${name}.wav is ${ms.toFixed(0)} ms, over the ${MAX_MS} ms cue budget`);
  }
}

function assertRingBudget(name, bytes, ms) {
  if (bytes.length > RING_MAX_BYTES) {
    throw new Error(`${name}.wav is ${bytes.length} B, over the ${RING_MAX_BYTES} B ringtone budget`);
  }
  if (ms > RING_MAX_MS) {
    throw new Error(`${name}.wav is ${ms.toFixed(0)} ms, over the ${RING_MAX_MS} ms ringtone budget`);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const rows = [];
for (const [name, parts] of Object.entries({ ...CUES, ...RINGTONE })) {
  const ringtone = name in RINGTONE;
  const samples = render(parts, CUE_PEAK[name] ?? PEAK);
  const bytes = wav(samples);
  const ms = (samples.length / SAMPLE_RATE) * 1000;
  if (ringtone) assertRingBudget(name, bytes, ms);
  else assertBudget(name, bytes, ms);
  const file = path.join(OUT_DIR, `${name}.wav`);
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const changed = before === null || !before.equals(bytes);
  if (changed) fs.writeFileSync(file, bytes);
  rows.push({ name, bytes: bytes.length, ms, state: before === null ? 'new' : changed ? 'updated' : 'unchanged' });
}

const relative = path.relative(ROOT, OUT_DIR);
for (const row of rows) {
  process.stdout.write(
    `${relative}/${row.name}.wav  ${String(row.bytes).padStart(6)} B  ${row.ms.toFixed(0).padStart(4)} ms  ${row.state}\n`,
  );
}
process.stdout.write(
  `${rows.length} cue files, 44.1 kHz 16-bit mono; peak ${PEAK} of full scale, except `
  + `${Object.entries(CUE_PEAK).map(([name, peak]) => `${name} at ${peak}`).join(' and ')}\n`
  + 'call_ringback.wav and call_ring_phone.wav are NOT written here: both are '
  + 'shipped recordings, cut from assets/sounds/ — see its CREDITS.txt.\n',
);
