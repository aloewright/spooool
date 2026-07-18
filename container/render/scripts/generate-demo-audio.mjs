import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const PEAK_LIMIT = 0.82;
const FADE_IN_SECONDS = 0.6;
const FADE_OUT_SECONDS = 0.9;

const clamp = (value, minimum, maximum) =>
  Math.min(Math.max(value, minimum), maximum);

const createXorshift32 = (seed) => {
  let state = seed >>> 0;

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
};

const smoothStep = (value) => {
  const clamped = clamp(value, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
};

const cueEnvelope = (secondsFromCue) => {
  if (secondsFromCue < 0 || secondsFromCue >= 0.68) return 0;
  return Math.exp(-secondsFromCue * 5.4) * Math.sin(Math.PI * secondsFromCue / 0.68);
};

/**
 * Create a deterministic, original stereo PCM bed using only local synthesis.
 * Samples are signed 16-bit PCM values interleaved left/right.
 */
export const createDemoPcm = ({
  durationSeconds,
  sampleRate,
  seed,
  cueSeconds,
}) => {
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new Error("durationSeconds must be a positive integer");
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("sampleRate must be a positive integer");
  }

  const frameCount = durationSeconds * sampleRate;
  const samples = new Int16Array(frameCount * CHANNELS);
  const random = createXorshift32(seed);
  let filteredNoiseLeft = 0;
  let filteredNoiseRight = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / sampleRate;
    const padLfo = Math.sin(Math.PI * 2 * 0.047 * time);
    const pad =
      Math.sin(Math.PI * 2 * (110 + padLfo * 0.32) * time) * 0.19 +
      Math.sin(Math.PI * 2 * (164.814 + padLfo * 0.24) * time + 0.42) * 0.15 +
      Math.sin(Math.PI * 2 * 220 * time + 1.1) * 0.045;

    const pulsePosition = time % 1.75;
    const pulseEnvelope = Math.exp(-pulsePosition * 5.2);
    const pluck =
      pulseEnvelope *
      (Math.sin(Math.PI * 2 * 329.628 * pulsePosition) * 0.12 +
        Math.sin(Math.PI * 2 * 493.883 * pulsePosition) * 0.045);

    const nearestCue = cueSeconds.reduce(
      (closest, cue) => Math.min(closest, Math.abs(time - cue)),
      Number.POSITIVE_INFINITY,
    );
    const swell = smoothStep(1 - nearestCue / 1.1) * 0.08;
    filteredNoiseLeft = filteredNoiseLeft * 0.965 + (random() * 2 - 1) * 0.035;
    filteredNoiseRight = filteredNoiseRight * 0.965 + (random() * 2 - 1) * 0.035;

    const cue = cueSeconds.reduce((total, cueTime, index) => {
      const secondsFromCue = time - cueTime;
      const pitch = index % 2 === 0 ? 659.255 : 783.991;
      return total + cueEnvelope(secondsFromCue) * Math.sin(Math.PI * 2 * pitch * secondsFromCue) * 0.22;
    }, 0);

    const fadeIn = smoothStep(time / FADE_IN_SECONDS);
    const fadeOut = smoothStep((durationSeconds - time) / FADE_OUT_SECONDS);
    const envelope = fadeIn * fadeOut;
    const left = clamp((pad + pluck + filteredNoiseLeft * swell + cue) * envelope, -PEAK_LIMIT, PEAK_LIMIT);
    const right = clamp(
      (pad * 0.97 + pluck * 0.9 + filteredNoiseRight * swell + cue * 0.94) * envelope,
      -PEAK_LIMIT,
      PEAK_LIMIT,
    );

    samples[frame * CHANNELS] = Math.round(left * 32_767);
    samples[frame * CHANNELS + 1] = Math.round(right * 32_767);
  }

  return samples;
};

export const encodeWav = ({ samples, sampleRate }) => {
  if (!(samples instanceof Int16Array)) {
    throw new Error("samples must be an Int16Array");
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("sampleRate must be a positive integer");
  }

  const dataSize = samples.byteLength;
  const wav = new Uint8Array(44 + dataSize);
  const view = new DataView(wav.buffer);
  const encoder = new TextEncoder();
  const writeAscii = (offset, value) => wav.set(encoder.encode(value), offset);

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * CHANNELS * (BITS_PER_SAMPLE / 8), true);
  view.setUint16(32, CHANNELS * (BITS_PER_SAMPLE / 8), true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  wav.set(new Uint8Array(samples.buffer, samples.byteOffset, dataSize), 44);

  return wav;
};

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIRECTORY = resolve(SCRIPT_DIRECTORY, "../remotion/public/demo/audio");
const SAMPLE_RATE = 48_000;
const AUDIO_BEDS = [
  {
    fileName: "spooool-demo-landscape.wav",
    durationSeconds: 30,
    seed: 90_030,
    cueSeconds: [0, 3, 8, 14, 21, 26],
  },
  {
    fileName: "spooool-demo-vertical.wav",
    durationSeconds: 22,
    seed: 66_030,
    cueSeconds: [0, 2, 6, 11, 16, 19],
  },
];

const generateDemoAudio = async () => {
  await mkdir(AUDIO_DIRECTORY, { recursive: true });

  for (const audioBed of AUDIO_BEDS) {
    const samples = createDemoPcm({ ...audioBed, sampleRate: SAMPLE_RATE });
    const wav = encodeWav({ samples, sampleRate: SAMPLE_RATE });
    await writeFile(resolve(AUDIO_DIRECTORY, audioBed.fileName), wav);
    console.log(`Generated ${audioBed.fileName}`);
  }
};

if (isMainModule({ argvPath: process.argv[1], moduleUrl: import.meta.url })) {
  await generateDemoAudio();
}
