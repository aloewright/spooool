import { describe, expect, it } from "vitest";
import { createDemoPcm, encodeWav } from "./generate-demo-audio.mjs";

const sampleRate = 48_000;
const durationSeconds = 1;
const options = {
  durationSeconds,
  sampleRate,
  seed: 90_030,
  cueSeconds: [0, 0.5],
};

describe("demo audio synthesis", () => {
  it("creates byte-identical PCM for equal inputs", () => {
    expect(createDemoPcm(options)).toEqual(createDemoPcm(options));
  });

  it("changes PCM when its seed changes", () => {
    const alternate = { ...options, seed: 66_030 };

    expect(createDemoPcm(options)).not.toEqual(createDemoPcm(alternate));
  });

  it("returns the expected number of interleaved stereo samples", () => {
    const samples = createDemoPcm(options);

    expect(samples).toHaveLength(durationSeconds * sampleRate * 2);
  });

  it("encodes PCM as a RIFF/WAVE file with a matching data chunk", () => {
    const samples = createDemoPcm(options);
    const wav = encodeWav({ samples, sampleRate });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(40, true)).toBe(samples.byteLength);
    expect(wav.byteLength).toBe(44 + samples.byteLength);
  });
});
