import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';

export const WAVEFORM_BARS = [
  '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588',
];

/**
 * Computes a Unicode block waveform from an array or TypedArray of numeric samples (-1.0..1.0 or Int16).
 * @param {ArrayLike<number>} samples - Audio samples
 * @param {number} columns - Number of waveform bars to generate (default 24)
 * @returns {string} - Unicode waveform string (e.g. " ▂▃▅▆▇█▇▆▅▃▂ ")
 */
export function computeWaveform(samples, columns = 24) {
  if (!samples || samples.length === 0) {
    return '—'.repeat(Math.max(1, columns));
  }
  const cols = Math.max(1, Math.min(columns, 64));
  const chunkSize = Math.max(1, Math.floor(samples.length / cols));
  const rmsValues = [];
  let maxRms = 0;

  for (let c = 0; c < cols; c++) {
    const start = c * chunkSize;
    const end = Math.min(samples.length, start + chunkSize);
    if (start >= samples.length) break;

    let sumSquares = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const val = Number(samples[i]) || 0;
      // Normalise if Int16
      const norm = Math.abs(val) > 1 ? val / 32768 : val;
      sumSquares += norm * norm;
      count += 1;
    }
    const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
    if (rms > maxRms) maxRms = rms;
    rmsValues.push(rms);
  }

  if (maxRms === 0) {
    return WAVEFORM_BARS[0].repeat(rmsValues.length);
  }

  return rmsValues.map((rms) => {
    const ratio = Math.min(1, Math.max(0, rms / maxRms));
    const index = Math.min(WAVEFORM_BARS.length - 1, Math.round(ratio * (WAVEFORM_BARS.length - 1)));
    return WAVEFORM_BARS[index];
  }).join('');
}

/**
 * Parses a standard RIFF/WAVE PCM buffer and extracts duration and samples.
 * @param {Buffer} buffer - Raw WAV file bytes
 * @returns {{ durationSec: number, sampleRate: number, channels: number, waveform: string, isSilent: boolean } | null}
 */
export function parseWavPcm(buffer, { waveformCols = 24 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      if (chunkSize >= 16 && offset + 8 + 16 <= buffer.length) {
        numChannels = buffer.readUInt16LE(offset + 10);
        sampleRate = buffer.readUInt32LE(offset + 12);
        bitsPerSample = buffer.readUInt16LE(offset + 22);
      }
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(chunkSize, buffer.length - dataOffset);
      break;
    }
    offset += 8 + chunkSize;
  }

  if (dataOffset === -1 || dataSize <= 0) return null;

  const bytesPerSample = Math.max(1, Math.floor(bitsPerSample / 8));
  const totalSamples = Math.floor(dataSize / (bytesPerSample * numChannels));
  const durationSec = sampleRate > 0 ? totalSamples / sampleRate : 0;

  const samples = [];
  const step = Math.max(1, Math.floor(totalSamples / 1024)); // sub-sample for speed

  if (bitsPerSample === 16) {
    for (let i = 0; i < totalSamples; i += step) {
      const byteIdx = dataOffset + i * bytesPerSample * numChannels;
      if (byteIdx + 2 <= buffer.length) {
        samples.push(buffer.readInt16LE(byteIdx));
      }
    }
  } else if (bitsPerSample === 8) {
    for (let i = 0; i < totalSamples; i += step) {
      const byteIdx = dataOffset + i * numChannels;
      if (byteIdx < buffer.length) {
        samples.push((buffer[byteIdx] - 128) * 256);
      }
    }
  }

  let sumSq = 0;
  let activeCount = 0;
  for (const s of samples) {
    const norm = s / 32768;
    sumSq += norm * norm;
    if (Math.abs(s) > 300) activeCount++;
  }
  const rms = samples.length > 0 ? Math.sqrt(sumSq / samples.length) : 0;
  const activeRatio = samples.length > 0 ? activeCount / samples.length : 0;
  const isSilent = rms < 0.005 || activeRatio < 0.02;

  const waveform = computeWaveform(samples, waveformCols);
  return {
    durationSec,
    sampleRate,
    channels: numChannels,
    waveform,
    isSilent,
  };
}

const base64Chars = (bytes) => Math.ceil(bytes / 3) * 4;

// The same chunk walk parseWavPcm does, kept apart because a rewrite needs the
// offsets that one throws away.
function wavLayout(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  let channels = 1;
  let sampleRate = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ' && chunkSize >= 16 && offset + 24 <= buffer.length) {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      return {
        channels,
        sampleRate,
        bitsPerSample,
        dataOffset: offset + 8,
        dataSize: Math.min(chunkSize, buffer.length - offset - 8),
      };
    }
    offset += 8 + chunkSize;
  }
  return null;
}

// A canonical 44-byte mono PCM header: the only WAV shape this file writes.
function writeWavPcm(samples, sampleRate) {
  const bytes = samples.length * 2;
  const out = Buffer.alloc(44 + bytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + bytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28); // byte rate
  out.writeUInt16LE(2, 32); // block align
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2);
  return out;
}

// Speech survives 8 kHz — that is a telephone — and below it stops being worth
// sending, so this is where halving stops.
export const VOICE_MIN_SAMPLE_RATE = 8000;

// How long `/voice` records when told no number. Five seconds was a demo
// length: long enough to prove the microphone works, too short for an actual
// message, so every real note needed an argument. A minute is the useful
// default now that a recording can be finished early (`onStart`'s `stop`).
export const VOICE_DEFAULT_SECONDS = 60;

// The ceiling. Held at five minutes because that is what still fits a cloud
// peer's message frame once `fitWavForCloud` has halved it to telephone rate
// — a longer note would be recorded in full and then refused on the way out.
export const VOICE_MAX_SECONDS = 300;

// A voice note reaches a cloud peer inline on the message frame, base64, and
// the hub refuses a frame over its media ceiling. 16 kHz mono 16-bit is
// 32 KB/s, so the five minutes `/voice` offers is 9.6 MB — 12.8 MB once base64
// has grown it by a third — and the refusal used to arrive *after* the person
// had spoken for five minutes. Halving the sample rate halves the bytes, which
// turns that recording into 6.4 MB of perfectly intelligible telephone speech.
// A recording that already fits is returned as the very same buffer, untouched;
// anything that is not our own mono 16-bit WAV is left alone for the send-side
// check to judge, exactly as before.
export function fitWavForCloud(buffer, maxBase64Chars) {
  if (!Buffer.isBuffer(buffer) || !(maxBase64Chars > 0)) return buffer;
  if (base64Chars(buffer.length) <= maxBase64Chars) return buffer;
  const layout = wavLayout(buffer);
  if (!layout || layout.bitsPerSample !== 16 || layout.channels !== 1) return buffer;
  if (layout.dataSize < 2) return buffer;
  let rate = layout.sampleRate;
  let samples = new Int16Array(Math.floor(layout.dataSize / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = buffer.readInt16LE(layout.dataOffset + i * 2);
  }
  while (rate >= VOICE_MIN_SAMPLE_RATE * 2 && base64Chars(44 + samples.length * 2) > maxBase64Chars) {
    const halved = new Int16Array(Math.floor(samples.length / 2));
    // The pair is averaged, not one of it dropped: the cheapest low-pass there
    // is, and without it everything above the new ceiling folds back as a
    // whistle over the voice.
    for (let i = 0; i < halved.length; i++) {
      halved[i] = (samples[i * 2] + samples[i * 2 + 1]) >> 1;
    }
    samples = halved;
    rate = Math.round(rate / 2);
  }
  if (rate === layout.sampleRate) return buffer;
  return writeWavPcm(samples, rate);
}

// A browser voice note is Opus inside WebM, which `parseWavPcm` cannot read —
// so the card fell back to a placeholder bar pattern that looks like a
// microphone with no waveform at all. ffmpeg, if it is here, decodes anything
// to raw mono PCM, which is all `computeWaveform` ever wanted. Absent ffmpeg
// this returns null and the card keeps its old fallback.
export function decodeToPcm(filePath, {
  spawnProcess = spawn, exists = binaryExists, env = process.env, platform = process.platform,
  timeoutMs = 10_000,
} = {}) {
  return new Promise((resolve) => {
    if (!exists('ffmpeg', env, platform)) return resolve(null);
    let child;
    try {
      // 8 kHz mono is far below speech quality and far above what 24 bars of
      // waveform can show: this is a picture, not a copy.
      child = spawnProcess('ffmpeg', [
        '-v', 'quiet', '-i', filePath, '-f', 's16le', '-ac', '1', '-ar', '8000', '-',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const chunks = [];
    let total = 0;
    // Two minutes of 8 kHz mono. A five-minute note is still drawn, from its
    // first two minutes — a waveform is an impression, and an unbounded buffer
    // for a decoration is not worth it.
    const cap = 8000 * 2 * 120;
    child.stdout.on('data', (chunk) => {
      if (total >= cap) return;
      chunks.push(chunk);
      total += chunk.length;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (value) => { clearTimeout(timer); resolve(value); };
    child.on('error', () => finish(null));
    child.on('close', () => {
      if (total === 0) return finish(null);
      const buf = Buffer.concat(chunks);
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
      finish(samples);
    });
    return undefined;
  });
}

export function formatDurationShort(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// The card a voice note gets in the transcript. `openWith` is the command that
// plays it: a waveform is a lovely thing to look at and says nothing whatever
// about how to hear it, and a reader who cannot work that out simply never
// listens to the message.
export function formatVoiceCard(durationSec, waveform, { openWith = null } = {}) {
  const durStr = formatDurationShort(durationSec);
  const wave = waveform || '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
  const card = `🎙 [${durStr}] ${wave}`;
  return openWith ? `${card}  ▶ ${openWith}` : card;
}

export function parseAvfoundationAudioDevices(output) {
  const text = String(output ?? '');
  const audioIndex = text.indexOf('AVFoundation audio devices:');
  if (audioIndex === -1) return [];
  const section = text.slice(audioIndex);
  const matches = [...section.matchAll(/\[(\d+)\]\s+([^\n\r]+)/g)];
  return matches.map((m) => ({ index: m[1], name: m[2].trim() }));
}

export function selectBestMicIndex(devices) {
  if (!devices || devices.length === 0) return 'default';
  const mic = devices.find((d) => /microphone|mic|macbook|built-in|internal|встроен/i.test(d.name));
  if (mic) return mic.index;
  const nonVirtual = devices.filter((d) => !/background music|blackhole|soundflower|loopback|ui sounds/i.test(d.name));
  if (nonVirtual.length > 0) return nonVirtual[0].index;
  return devices[0].index;
}

export async function detectDarwinMicIndex(exec = execFile) {
  return new Promise((resolve) => {
    exec('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], (_err, stdout, stderr) => {
      const output = `${stdout ?? ''}\n${stderr ?? ''}`;
      const devices = parseAvfoundationAudioDevices(output);
      resolve(selectBestMicIndex(devices));
    });
  });
}

export async function listAudioInputDevices({ platform = process.platform, env = process.env, exec = execFile } = {}) {
  if (platform === 'darwin') {
    return new Promise((resolve) => {
      exec('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], (_err, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`;
        resolve(parseAvfoundationAudioDevices(output));
      });
    });
  }
  if (env?.TERMUX_VERSION) {
    return [{ index: '0', name: 'Termux Default Microphone' }];
  }
  return [{ index: 'default', name: 'Default Audio Input' }];
}

/**
 * Detects the available audio recording tool.
 */
export function probeAudioRecorder(platform = process.platform, env = process.env) {
  if (env?.TERMUX_VERSION) {
    return { cmd: 'termux-microphone-record', kind: 'termux' };
  }
  if (platform === 'darwin') {
    return { cmd: 'ffmpeg', kind: 'ffmpeg-darwin', args: ['-f', 'avfoundation', '-i', ':default'] };
  }
  if (platform === 'win32') {
    return { cmd: 'ffmpeg', kind: 'ffmpeg-win', args: ['-f', 'dshow', '-i', 'audio=default'] };
  }
  return { cmd: 'arecord', kind: 'arecord', args: ['-f', 'cd', '-t', 'wav'] };
}

/**
 * Detects the available audio playback tool.
 */
export function probeAudioPlayer(platform = process.platform, env = process.env) {
  if (env?.TERMUX_VERSION) {
    return { cmd: 'termux-media-player', kind: 'termux' };
  }
  if (platform === 'darwin') {
    return { cmd: 'afplay', kind: 'afplay' };
  }
  if (platform === 'win32') {
    return { cmd: 'powershell', kind: 'powershell', args: ['-c'] };
  }
  return { cmd: 'aplay', kind: 'aplay' };
}
const MAC_RECORDER_NAME = 'TailchatVoiceRecorder';
const MAC_RECORDER_SOURCE = fileURLToPath(new URL('./macos-voice-recorder.swift', import.meta.url));

export function macRecorderPaths(stateDir = path.join(os.homedir(), '.tailchat')) {
  const app = path.join(stateDir, 'bin', `${MAC_RECORDER_NAME}.app`);
  return {
    app,
    executable: path.join(app, 'Contents', 'MacOS', MAC_RECORDER_NAME),
    plist: path.join(app, 'Contents', 'Info.plist'),
  };
}

const MAC_RECORDER_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${MAC_RECORDER_NAME}</string>
  <key>CFBundleIdentifier</key><string>net.tailchat.voice-recorder</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Tailchat Voice Recorder</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Tailchat records voice notes you explicitly send.</string>
</dict>
</plist>
`;

// `onChild` hands the spawned process to the caller the moment it exists, so
// a recording can be finished early (see `recordAudio`'s `onStart`). A
// process the caller stopped on purpose exits non-zero — killed by a signal —
// and that is a completed recording, not a failure, which is what `stopped`
// distinguishes.
function runExec(exec, command, args, options = {}, onChild = null) {
  return new Promise((resolve, reject) => {
    let stopped = false;
    const child = exec(command, args, options, (error, stdout, stderr) => {
      if (error && !stopped) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (onChild && child) {
      onChild(() => {
        if (stopped) return;
        stopped = true;
        // SIGINT, never SIGKILL: every recorder here writes its container's
        // final header on a clean interrupt, and a killed one leaves a WAV
        // whose length field says zero.
        try { child.kill('SIGINT'); } catch {}
      });
    }
  });
}

export async function ensureDarwinRecorder({
  stateDir = path.join(os.homedir(), '.tailchat'),
  exec = execFile,
} = {}) {
  const paths = macRecorderPaths(stateDir);
  let rebuild = true;
  try {
    const sourceChanged = fs.statSync(paths.executable).mtimeMs < fs.statSync(MAC_RECORDER_SOURCE).mtimeMs;
    const plistChanged = fs.readFileSync(paths.plist, 'utf8') !== MAC_RECORDER_PLIST;
    rebuild = sourceChanged || plistChanged;
  } catch {
    rebuild = true;
  }
  if (!rebuild) return paths.executable;

  fs.mkdirSync(path.dirname(paths.executable), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.plist, MAC_RECORDER_PLIST, { mode: 0o600 });
  await runExec(exec, 'swiftc', [
    MAC_RECORDER_SOURCE,
    '-o', paths.executable,
    '-framework', 'AVFoundation',
    '-framework', 'Foundation',
  ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  fs.chmodSync(paths.executable, 0o700);
  try {
    await runExec(exec, 'codesign', ['--force', '--deep', '--sign', '-', paths.app], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    // An ad-hoc signature improves TCC identity but is not required to execute.
  }
  return paths.executable;
}

export function normaliseVoiceBackend(value, platform = process.platform) {
  const backend = String(value ?? 'auto').trim().toLowerCase();
  if (backend === 'auto') return 'auto';
  if (backend === 'ffmpeg') return 'ffmpeg';
  if (backend === 'native' && platform === 'darwin') return 'native';
  return null;
}

export async function recordAudio(outputPath, {
  durationSec = VOICE_DEFAULT_SECONDS,
  device = null,
  backend = 'auto',
  stateDir = path.join(os.homedir(), '.tailchat'),
  platform = process.platform,
  env = process.env,
  exec = execFile,
  // Called once the recorder is running, with the function that finishes the
  // recording early. That is what makes a long `/voice` usable: the person
  // says what they wanted to say and stops, instead of waiting out the clock
  // or losing the take.
  onStart = null,
} = {}) {
  const selectedBackend = normaliseVoiceBackend(backend, platform);
  if (!selectedBackend) throw new Error(`unsupported voice backend: ${backend}`);
  // Five minutes, the same ceiling `/voice` offers: clamping lower here would
  // silently cut a recording the caller was told it could make.
  const dur = Math.max(1, Math.min(VOICE_MAX_SECONDS, Math.round(Number(durationSec) || VOICE_DEFAULT_SECONDS)));
  // On top of the recording itself: opening a capture device is not instant —
  // avfoundation takes a moment, dshow enumeration on Windows takes several —
  // and a 9.6 MB WAV still has to be flushed when the time is up. Five seconds
  // of slack was thin at five seconds of audio and a coin flip at five minutes,
  // where being killed one second early means a truncated file instead of a
  // message. The buffer below is only for the recorder's own log chatter (the
  // audio goes straight to outputPath): ffmpeg prints a progress line about
  // twice a second, so five minutes of it is tens of kilobytes against 8 MiB.
  const timeout = dur * 1000 + 20_000;

  if (platform === 'darwin' && selectedBackend !== 'ffmpeg') {
    try {
      const executable = await ensureDarwinRecorder({ stateDir, exec });
      await runExec(exec, executable, [outputPath, String(dur)], {
        maxBuffer: 8 * 1024 * 1024,
        timeout,
      }, onStart ? (stop) => onStart({ stop, backend: 'native' }) : null);
      return { outputPath, device: 'system-default', backend: 'native' };
    } catch (error) {
      if (selectedBackend === 'native') throw error;
      // Auto mode keeps the old ffmpeg path as a fallback when Swift tooling
      // is unavailable. Silence detection still prevents empty transmission.
    }
  }

  const recorder = probeAudioRecorder(platform, env);
  if (!recorder) throw new Error('No audio recorder available');
  let args = [];
  let chosenDevice = device;
  if (recorder.kind === 'ffmpeg-darwin') {
    if (!chosenDevice || chosenDevice === 'auto') {
      try {
        chosenDevice = await detectDarwinMicIndex(exec);
      } catch {
        chosenDevice = 'default';
      }
    }
    args = ['-y', '-f', 'avfoundation', '-i', `:${chosenDevice}`, '-t', String(dur), '-ac', '1', '-ar', '16000', outputPath];
  } else if (recorder.kind === 'ffmpeg-win') {
    const devName = chosenDevice && chosenDevice !== 'auto' ? chosenDevice : 'default';
    args = ['-y', '-f', 'dshow', '-i', `audio=${devName}`, '-t', String(dur), '-ac', '1', '-ar', '16000', outputPath];
  } else if (recorder.kind === 'termux') {
    args = ['-d', '-l', String(dur), '-f', outputPath];
  } else {
    // 16 kHz mono, like every other backend: `-f cd` is 44.1 kHz stereo, which
    // is 176 KB/s — a five-minute note recorded on Linux came out 53 MB, over
    // every ceiling it had to pass, and carried no more speech for it.
    args = ['-d', String(dur), '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', outputPath];
  }
  await runExec(exec, recorder.cmd, args, {
    maxBuffer: 8 * 1024 * 1024,
    timeout,
  }, onStart ? (stop) => onStart({ stop, backend: recorder.kind }) : null);
  return { outputPath, device: chosenDevice, backend: recorder.kind };
}
// A recording must never exist as a plaintext temporary WAV. The capture
// process streams a bounded WAV to memory, then the caller encrypts it.
export async function recordAudioBuffer({
  durationSec = VOICE_DEFAULT_SECONDS,
  device = null,
  backend = 'auto',
  platform = process.platform,
  env = process.env,
  spawnProcess = spawn,
  onStart = null,
} = {}) {
  if (env?.TERMUX_VERSION) throw new Error('Termux recorder requires a plaintext output path; secure voice capture unavailable');
  if (backend === 'native') throw new Error('Native recorder requires a plaintext output path; use the ffmpeg voice backend');
  if (backend !== 'auto' && backend !== 'ffmpeg') throw new Error(`unsupported voice backend: ${backend}`);
  const duration = Math.max(1, Math.min(VOICE_MAX_SECONDS, Math.round(Number(durationSec) || VOICE_DEFAULT_SECONDS)));
  const recorder = probeAudioRecorder(platform, env);
  const selected = device && device !== 'auto' ? device : 'default';
  const args = recorder.kind === 'ffmpeg-darwin'
    ? ['-loglevel', 'error', '-f', 'avfoundation', '-i', `:${selected}`, '-t', String(duration), '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1']
    : recorder.kind === 'ffmpeg-win'
      ? ['-loglevel', 'error', '-f', 'dshow', '-i', `audio=${selected}`, '-t', String(duration), '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1']
      : ['-d', String(duration), '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', '-'];
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess(recorder.cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };
    const timeout = setTimeout(() => fail(new Error('Audio capture timed out')), duration * 1000 + 20_000);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) return fail(new Error('Audio exceeds secure recording limit'));
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const payload = Buffer.concat(chunks);
      if (code !== 0 && !payload.length) return reject(new Error(stderr || `Audio recorder exited ${code}`));
      if (!payload.length) return reject(new Error('Audio recorder produced no data'));
      if (payload.toString('ascii', 0, 4) === 'RIFF' && payload.toString('ascii', 8, 12) === 'WAVE') {
        payload.writeUInt32LE(payload.length - 8, 4);
        let offset = 12;
        while (offset + 8 <= payload.length) {
          const size = payload.readUInt32LE(offset + 4);
          if (payload.toString('ascii', offset, offset + 4) === 'data') {
            payload.writeUInt32LE(payload.length - offset - 8, offset + 4);
            break;
          }
          offset += 8 + size + (size & 1);
        }
      }
      resolve({ payload, device: selected, backend: recorder.kind });
    });
    onStart?.({ stop: () => child.kill('SIGINT'), backend: recorder.kind });
  });
}

// What each platform player can actually decode. This matters because the
// probe above answers "what does this OS ship with", not "can it open this
// file": `aplay` is a raw ALSA WAV pipe, PowerShell's SoundPlayer is WAV-only,
// and `afplay` goes through CoreAudio, which has no Opus decoder. A voice note
// recorded in the web client is Opus inside WebM — so on every platform the
// default player was being handed a file it cannot read, spawning happily and
// playing nothing while the terminal said «▶ playing». Termux is the exception:
// it hands the file to Android's MediaPlayer, which handles the lot.
const PLAYER_FORMATS = {
  afplay: new Set(['.wav', '.mp3', '.m4a', '.aac', '.aiff', '.aif', '.caf']),
  aplay: new Set(['.wav']),
  powershell: new Set(['.wav']),
  termux: null, // null means "no restriction"
};

// Decoders that handle essentially anything, including WebM/Opus. Preferred
// whenever the platform player cannot read the file, because playing in place
// is the point — the alternative is throwing a voice note at a desktop app.
const UNIVERSAL_PLAYERS = [
  { cmd: 'mpv', kind: 'mpv' },
  { cmd: 'ffplay', kind: 'ffplay' },
  { cmd: 'mplayer', kind: 'mplayer' },
];

/**
 * Whether a command can be found on PATH. Cheaper and more predictable than
 * shelling out to `which`, which does not exist everywhere this runs.
 */
export function binaryExists(cmd, env = process.env, platform = process.platform) {
  if (!cmd) return false;
  if (cmd.includes(path.sep)) return fs.existsSync(cmd);
  const dirs = String(env?.PATH ?? '').split(platform === 'win32' ? ';' : ':');
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      try {
        if (fs.existsSync(path.join(dir, cmd + suffix))) return true;
      } catch {
        // An unreadable PATH entry is simply not where the binary is.
      }
    }
  }
  return false;
}

/**
 * The player to use for one specific file, or null when nothing installed can
 * decode it — which the caller should read as "hand this to the system opener"
 * rather than as an error.
 */
export function resolveAudioPlayer(filePath, {
  platform = process.platform,
  env = process.env,
  exists = binaryExists,
} = {}) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  const native = probeAudioPlayer(platform, env);
  const formats = native ? PLAYER_FORMATS[native.kind] : undefined;
  // `undefined` is an unknown kind rather than an unrestricted one: only an
  // explicit null in the table means "plays anything".
  const nativeFits = native && (formats === null || (formats && formats.has(ext)));
  if (nativeFits && exists(native.cmd, env, platform)) return native;
  for (const player of UNIVERSAL_PLAYERS) {
    if (exists(player.cmd, env, platform)) return player;
  }
  return null;
}

export function playAudio(filePath, {
  platform = process.platform,
  env = process.env,
  spawnProcess = spawn,
  exists = binaryExists,
} = {}) {
  const player = resolveAudioPlayer(filePath, { platform, env, exists });
  if (!player) return null;
  const cmd = player.cmd;
  let args = [];
  if (player.kind === 'powershell') {
    args = ['-NoProfile', '-NonInteractive', '-c', `(New-Object Media.SoundPlayer '${filePath.replace(/'/g, "''")}').PlaySync()`];
  } else if (player.kind === 'termux') {
    args = ['play', filePath];
  } else if (player.kind === 'mpv') {
    // No window and no terminal output: this plays underneath a full-screen
    // TUI, and anything either of them writes would corrupt the other.
    args = ['--no-video', '--really-quiet', '--no-terminal', filePath];
  } else if (player.kind === 'ffplay') {
    args = ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath];
  } else if (player.kind === 'mplayer') {
    args = ['-really-quiet', '-novideo', filePath];
  } else {
    args = [filePath];
  }
  try {
    const child = spawnProcess(cmd, args, { stdio: 'ignore', detached: true });
    child.unref?.();
    return child;
  } catch {
    return null;
  }
}
