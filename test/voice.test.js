import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WAVEFORM_BARS,
  computeWaveform,
  parseWavPcm,
  formatDurationShort,
  formatVoiceCard,
  parseAvfoundationAudioDevices,
  selectBestMicIndex,
  detectDarwinMicIndex,
  macRecorderPaths,
  normaliseVoiceBackend,
  recordAudio,
  fitWavForCloud,
  VOICE_MIN_SAMPLE_RATE,
  probeAudioRecorder,
  probeAudioPlayer,
  resolveAudioPlayer,
  playAudio,
} from '../src/voice.js';

test('computeWaveform maps audio samples to proportional Unicode bars', () => {
  // Empty or invalid input
  assert.equal(computeWaveform([], 10), '——————————');
  assert.equal(computeWaveform(null, 5), '—————');

  // Silence (all zeros) produces a solid lower baseline, never whitespace
  const silence = new Array(100).fill(0);
  const silentWave = computeWaveform(silence, 8);
  assert.equal(silentWave, '\u2581'.repeat(8));
  // Dynamic samples with ascending amplitude
  const ramp = [];
  for (let i = 0; i < 240; i++) {
    const val = (i / 240) * 32000;
    ramp.push(val);
  }
  const wave = computeWaveform(ramp, 8);
  assert.equal(wave.length, 8);
  // Bars should generally increase in height
  assert.ok(WAVEFORM_BARS.indexOf(wave[0]) <= WAVEFORM_BARS.indexOf(wave[wave.length - 1]));
});

test('parseWavPcm parses standard 16-bit PCM WAV headers and extracts duration and waveform', () => {
  // Create a synthetic 1-second 16kHz 16-bit mono PCM WAV buffer
  const sampleRate = 16000;
  const numSamples = 16000;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24); // sample rate
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Fill data with a simple 440Hz sine wave
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 20000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }

  const parsed = parseWavPcm(buffer, { waveformCols: 16 });
  assert.ok(parsed);
  assert.equal(parsed.durationSec, 1.0);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.waveform.length, 16);
  assert.ok(parsed.waveform.includes('█') || parsed.waveform.includes('▇'));
});

test('parseWavPcm correctly identifies silent recordings and sparse click spikes', () => {
  // 1. Silent buffer with a single startup click spike
  const sampleRate = 16000;
  const numSamples = 16000;
  const buffer = Buffer.alloc(44 + numSamples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  // Put 10 spike samples of high amplitude (25000), rest 0
  for (let i = 0; i < 10; i++) {
    buffer.writeInt16LE(25000, 44 + i * 2);
  }
  const spikeParsed = parseWavPcm(buffer);
  assert.ok(spikeParsed);
  assert.equal(spikeParsed.isSilent, true, 'sparse startup spike must be classified as silent');

  // 2. Continuous audio signal (speech simulation)
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 15000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  const speechParsed = parseWavPcm(buffer);
  assert.ok(speechParsed);
  assert.equal(speechParsed.isSilent, false, 'continuous audio signal must not be classified as silent');
});

test('parseWavPcm returns null for invalid or non-WAV data', () => {
  assert.equal(parseWavPcm(Buffer.from('not a wav file')), null);
  assert.equal(parseWavPcm(Buffer.alloc(20)), null);
  assert.equal(parseWavPcm(null), null);
});

test('formatDurationShort formats seconds into mm:ss', () => {
  assert.equal(formatDurationShort(0), '0:00');
  assert.equal(formatDurationShort(7), '0:07');
  assert.equal(formatDurationShort(65), '1:05');
  assert.equal(formatDurationShort(360), '6:00');
});

test('formatVoiceCard builds a styled card with duration and waveform', () => {
  const card = formatVoiceCard(7, '\u2581\u2582\u2583\u2585\u2586\u2587\u2588');
  assert.equal(card, '🎙 [0:07] \u2581\u2582\u2583\u2585\u2586\u2587\u2588');
});

test('probeAudioRecorder and probeAudioPlayer match platform tools', () => {
  // macOS
  const macRec = probeAudioRecorder('darwin', {});
  const macPlay = probeAudioPlayer('darwin', {});
  assert.equal(macRec.cmd, 'ffmpeg');
  assert.equal(macPlay.cmd, 'afplay');

  // Windows
  const winRec = probeAudioRecorder('win32', {});
  const winPlay = probeAudioPlayer('win32', {});
  assert.equal(winRec.cmd, 'ffmpeg');
  assert.equal(winPlay.cmd, 'powershell');

  // Termux
  const termuxRec = probeAudioRecorder('linux', { TERMUX_VERSION: '0.118' });
  const termuxPlay = probeAudioPlayer('linux', { TERMUX_VERSION: '0.118' });
  assert.equal(termuxRec.cmd, 'termux-microphone-record');
  assert.equal(termuxPlay.cmd, 'termux-media-player');

  // Linux default
  const linuxRec = probeAudioRecorder('linux', {});
  const linuxPlay = probeAudioPlayer('linux', {});
  assert.equal(linuxRec.cmd, 'arecord');
  assert.equal(linuxPlay.cmd, 'aplay');
});

test('parseAvfoundationAudioDevices parses audio devices list from ffmpeg output', () => {
  const sampleOutput = `
[AVFoundation indev @ 0x76d4c14140] AVFoundation video devices:
[AVFoundation indev @ 0x76d4c14140] [0] FaceTime HD Camera
[AVFoundation indev @ 0x76d4c14140] AVFoundation audio devices:
[AVFoundation indev @ 0x76d4c14140] [0] Background Music
[AVFoundation indev @ 0x76d4c14140] [1] MacBook Pro Microphone
[AVFoundation indev @ 0x76d4c14140] [2] Jump Desktop Microphone
`;
  const devices = parseAvfoundationAudioDevices(sampleOutput);
  assert.equal(devices.length, 3);
  assert.equal(devices[0].name, 'Background Music');
  assert.equal(devices[0].index, '0');
  assert.equal(devices[1].name, 'MacBook Pro Microphone');
  assert.equal(devices[1].index, '1');

  // Best microphone selector prefers real microphone over virtual sound drivers
  const best = selectBestMicIndex(devices);
  assert.equal(best, '1');
});

test('detectDarwinMicIndex queries ffmpeg and returns best mic index', async () => {
  const mockExec = (cmd, args, cb) => {
    const stderr = `
[AVFoundation indev] AVFoundation audio devices:
[AVFoundation indev] [0] Virtual Driver
[AVFoundation indev] [1] Built-in Microphone
`;
    cb(null, '', stderr);
  };
  const mic = await detectDarwinMicIndex(mockExec);
  assert.equal(mic, '1');
});

test('normaliseVoiceBackend validates backend against the platform', () => {
  assert.equal(normaliseVoiceBackend('auto', 'darwin'), 'auto');
  assert.equal(normaliseVoiceBackend('native', 'darwin'), 'native');
  assert.equal(normaliseVoiceBackend('ffmpeg', 'darwin'), 'ffmpeg');
  assert.equal(normaliseVoiceBackend('native', 'linux'), null);
  assert.equal(normaliseVoiceBackend('unknown', 'darwin'), null);
});

test('recordAudio native backend builds and runs the cached macOS helper', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-native-recorder-'));
  const output = path.join(stateDir, 'note.wav');
  const calls = [];
  const fakeWav = Buffer.alloc(44 + 3200);
  fakeWav.write('RIFF', 0);
  fakeWav.writeUInt32LE(fakeWav.length - 8, 4);
  fakeWav.write('WAVE', 8);
  fakeWav.write('fmt ', 12);
  fakeWav.writeUInt32LE(16, 16);
  fakeWav.writeUInt16LE(1, 20);
  fakeWav.writeUInt16LE(1, 22);
  fakeWav.writeUInt32LE(16000, 24);
  fakeWav.writeUInt32LE(32000, 28);
  fakeWav.writeUInt16LE(2, 32);
  fakeWav.writeUInt16LE(16, 34);
  fakeWav.write('data', 36);
  fakeWav.writeUInt32LE(3200, 40);

  const mockExec = (command, args, options, callback) => {
    calls.push({ command, args });
    if (command === 'swiftc') {
      const outputAt = args.indexOf('-o') + 1;
      fs.writeFileSync(args[outputAt], 'native-helper');
    } else if (command.endsWith('/TailchatVoiceRecorder')) {
      fs.writeFileSync(args[0], fakeWav);
    }
    callback(null, '', '');
  };

  try {
    const result = await recordAudio(output, {
      durationSec: 1,
      backend: 'native',
      stateDir,
      platform: 'darwin',
      exec: mockExec,
    });
    assert.equal(result.backend, 'native');
    assert.equal(result.device, 'system-default');
    assert.equal(fs.existsSync(output), true);
    assert.ok(calls.some(({ command }) => command === 'swiftc'));
    assert.ok(calls.some(({ command }) => command.endsWith('/TailchatVoiceRecorder')));
    assert.equal(fs.existsSync(macRecorderPaths(stateDir).plist), true);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// A voice note recorded in the browser is Opus inside WebM. Every platform
// default player refuses that, so picking one anyway is how «CLI не умеет
// открывать аудио» happened: the process spawned, exited, and played nothing.
test('a WebM voice note never goes to a player that cannot decode it', () => {
  const everything = () => true;

  // macOS: CoreAudio has no Opus decoder, so afplay must not be chosen.
  assert.equal(
    resolveAudioPlayer('/tmp/voice.webm', { platform: 'darwin', env: {}, exists: everything }).cmd,
    'mpv',
  );
  // ALSA's aplay is a raw WAV pipe; same reasoning on Linux.
  assert.equal(
    resolveAudioPlayer('/tmp/voice.webm', { platform: 'linux', env: {}, exists: everything }).cmd,
    'mpv',
  );
  // A format the platform player does handle still uses it — no point
  // preferring a heavyweight decoder for a plain WAV.
  assert.equal(
    resolveAudioPlayer('/tmp/note.wav', { platform: 'darwin', env: {}, exists: everything }).cmd,
    'afplay',
  );
});

test('with no universal decoder installed an undecodable file resolves to nothing', () => {
  // Only the platform default exists, and it cannot read WebM. Returning null
  // is what lets the caller fall back to the system opener instead of
  // reporting playback that never happens.
  const onlyNative = (cmd) => cmd === 'afplay';
  assert.equal(
    resolveAudioPlayer('/tmp/voice.webm', { platform: 'darwin', env: {}, exists: onlyNative }),
    null,
  );
  assert.equal(
    resolveAudioPlayer('/tmp/note.wav', { platform: 'darwin', env: {}, exists: onlyNative }).cmd,
    'afplay',
  );
});

test('a platform player that is not installed is not chosen for a format it supports', () => {
  const nothing = () => false;
  assert.equal(
    resolveAudioPlayer('/tmp/note.wav', { platform: 'linux', env: {}, exists: nothing }),
    null,
  );
});

test('Termux hands any container to Android MediaPlayer rather than refusing it', () => {
  const player = resolveAudioPlayer('/tmp/voice.webm', {
    platform: 'linux', env: { TERMUX_VERSION: '0.118' }, exists: () => true,
  });
  assert.equal(player.cmd, 'termux-media-player');
});

test('playAudio builds quiet, windowless arguments for a universal decoder', () => {
  const calls = [];
  const child = { unref() {}, on() {} };
  playAudio('/tmp/voice.webm', {
    platform: 'darwin',
    env: {},
    exists: (cmd) => cmd === 'ffplay',
    spawnProcess: (cmd, args) => { calls.push({ cmd, args }); return child; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'ffplay');
  // Nothing may draw a window or write to the terminal: this plays underneath
  // a full-screen TUI.
  assert.ok(calls[0].args.includes('-nodisp'));
  assert.ok(calls[0].args.includes('quiet'));
  assert.equal(calls[0].args.at(-1), '/tmp/voice.webm');
});

// A waveform says a voice message arrived and nothing whatever about how to
// hear it. A note that cannot be played might as well not have been sent.
test('a voice card carries the command that plays it', () => {
  const card = formatVoiceCard(7, '▂▅█▅▂', { openWith: '/open 3' });
  assert.ok(card.includes('0:07'), 'the duration still leads');
  assert.ok(card.includes('▂▅█▅▂'));
  assert.ok(card.includes('/open 3'), 'the reader is told how to listen');

  // Without one — a note this side just recorded, addressed by no index yet —
  // the card is exactly what it always was.
  assert.equal(formatVoiceCard(7, '▂▅█▅▂'), '🎙 [0:07] ▂▅█▅▂');
});

// A five-minute recording is what /voice offers and what the web client
// allows, and every layer between the two used to cut it short somewhere else.
const wavOf = (seconds, sampleRate = 16000) => {
  const samples = Math.round(seconds * sampleRate);
  const out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    out.writeInt16LE(Math.round(12000 * Math.sin(i / 8)), 44 + i * 2);
  }
  return out;
};

test('the native macOS recorder is allowed the full five minutes', () => {
  const source = fs.readFileSync(new URL('../src/macos-voice-recorder.swift', import.meta.url), 'utf8');
  assert.match(source, /duration <= 300/, 'the helper refused anything over 60 seconds');
  assert.doesNotMatch(source, /duration <= 60\b/);
});

test('a long recording gets time to finish and to be flushed', async () => {
  const seen = [];
  const mockExec = (command, args, options, callback) => {
    seen.push({ command, args, options });
    callback(null, '', '');
  };
  await recordAudio('/tmp/note.wav', {
    durationSec: 300, backend: 'ffmpeg', platform: 'linux', env: {}, exec: mockExec,
  });
  const [{ command, args, options }] = seen;
  assert.equal(command, 'arecord');
  // 16 kHz mono like every other backend: `-f cd` was 44.1 kHz stereo, five
  // minutes of which is 53 MB and over every ceiling it had to pass.
  assert.deepEqual(args, ['-d', '300', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', '/tmp/note.wav']);
  assert.ok(options.timeout > 300_000, `the recording must not be killed at its own length: ${options.timeout}`);
});

test('a recording too large for a cloud frame is resampled instead of refused', () => {
  const limit = 10 * 1024 * 1024;
  const long = wavOf(300);
  assert.ok(Math.ceil(long.length / 3) * 4 > limit, 'five minutes at 16 kHz overflows the frame');

  const fitted = fitWavForCloud(long, limit);
  assert.notEqual(fitted, long);
  assert.ok(Math.ceil(fitted.length / 3) * 4 <= limit, 'the resampled note fits');

  const parsed = parseWavPcm(fitted);
  assert.equal(parsed.sampleRate, VOICE_MIN_SAMPLE_RATE);
  assert.equal(parsed.channels, 1);
  // The same five minutes, not a truncated version of them.
  assert.ok(Math.abs(parsed.durationSec - 300) < 1, `duration kept: ${parsed.durationSec}`);
  assert.equal(parsed.isSilent, false);
});

test('a recording that already fits is handed back byte for byte', () => {
  const short = wavOf(5);
  assert.equal(fitWavForCloud(short, 10 * 1024 * 1024), short);
  // Not our own mono 16-bit WAV: left alone for the send-side check to judge,
  // exactly as before.
  const opus = Buffer.alloc(64 * 1024, 7);
  assert.equal(fitWavForCloud(opus, 1024), opus);
  // Already at the floor: halving further would trade speech for nothing, so
  // the buffer comes back untouched and the send-side check has the last word.
  const floored = wavOf(60, VOICE_MIN_SAMPLE_RATE);
  assert.equal(fitWavForCloud(floored, 1024), floored);
});
