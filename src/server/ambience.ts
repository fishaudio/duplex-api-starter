/**
 * Backend Ambience Bed Mixer + Speech Ducker (pure TypeScript + WebAssembly MP3 decode).
 *
 * Why mix ambience on the backend instead of the browser?
 *  1. Works identically across WebSockets, WebRTC, and PSTN/SIP telephony trunks.
 *  2. Sidechain ducking (-10 dB when the agent speaks, 100 ms hold, 300 ms release) keeps
 *     the agent's voice crisp above the kitchen and drive-thru lane background without pumping.
 *  3. Caller ASR never hears the ambience because only the outbound speaker path is mixed.
 */

import fs from "node:fs";
import path from "node:path";
import { MPEGDecoder } from "mpg123-decoder";

const REF_LUFS = -20.0;
const BED_LUFS = -30.44;
const SBR_DB = 25.0;

const loopCache = new Map<number, Float32Array>();
let rawDecoded44k: { samples: Float32Array; sampleRate: number } | null = null;

function resampleLinear(src: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return src;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(src.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = src[idx] ?? 0;
    const s1 = src[Math.min(idx + 1, src.length - 1)] ?? s0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

function prepareSeamlessLoop(samples: Float32Array, loopSamples: number, xfadeSamples: number): Float32Array {
  if (samples.length <= loopSamples || xfadeSamples <= 0) return samples;
  const out = new Float32Array(loopSamples);
  const xf = Math.min(xfadeSamples, loopSamples, samples.length - loopSamples);
  out.set(samples.subarray(xf, loopSamples), xf);
  for (let i = 0; i < xf; i++) {
    const w = (i + 0.5) / xf;
    out[i] = samples[i] * w + samples[loopSamples + i] * (1 - w);
  }
  return out;
}

export async function preloadAmbienceAsset(assetPath?: string): Promise<void> {
  if (rawDecoded44k) return;
  const mp3File = assetPath ?? path.resolve(process.cwd(), "assets", "drive_thru.mp3");
  if (!fs.existsSync(mp3File)) return;

  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const bytes = fs.readFileSync(mp3File);
    const decoded = decoder.decode(bytes);
    const ch0 = decoded.channelData[0];
    const ch1 = decoded.channelData[1];
    const mono = new Float32Array(ch0.length);
    if (ch1) {
      for (let i = 0; i < ch0.length; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    } else {
      mono.set(ch0);
    }
    rawDecoded44k = { samples: mono, sampleRate: decoded.sampleRate };
  } finally {
    decoder.free();
  }
}

function getDriveThruLoop(targetSampleRate: number): Float32Array {
  const cached = loopCache.get(targetSampleRate);
  if (cached) return cached;
  if (!rawDecoded44k) return new Float32Array(0);

  const resampled = resampleLinear(rawDecoded44k.samples, rawDecoded44k.sampleRate, targetSampleRate);
  const loopLen = Math.round(72.0 * targetSampleRate);
  const xfadeLen = Math.round(0.5 * targetSampleRate);
  const loop = prepareSeamlessLoop(resampled, loopLen, xfadeLen);
  loopCache.set(targetSampleRate, loop);
  return loop;
}

export class AmbienceMixer {
  public enabled: boolean;
  public levelDb: number;
  private sampleRate: number;
  private readonly duckLinear: number;
  private readonly holdS = 0.1;
  private readonly releaseS = 0.3;
  private readonly loudRms = 300.0;

  private pos = 0;
  private currentDuckGain = 1.0;
  private sinceLoudS: number | null = null;

  constructor(opts?: { sampleRate?: number; enabled?: boolean; levelDb?: number; duckDb?: number }) {
    this.sampleRate = opts?.sampleRate ?? 24000;
    this.enabled = opts?.enabled ?? true;
    this.levelDb = opts?.levelDb ?? 0.0;
    this.duckLinear = Math.pow(10, (opts?.duckDb ?? -10.0) / 20.0);
  }

  public setSampleRate(sr: number): void {
    if (sr !== this.sampleRate && sr > 0) {
      this.sampleRate = sr;
      this.pos = 0;
    }
  }

  public mixPcmS16le(agentPcm: Buffer): Buffer {
    const loop = getDriveThruLoop(this.sampleRate);
    if (!this.enabled || loop.length === 0 || agentPcm.byteLength < 2) {
      return agentPcm;
    }

    const sampleCount = Math.floor(agentPcm.byteLength / 2);
    let sumSq = 0;
    for (let i = 0; i < sampleCount; i++) {
      const s = agentPcm.readInt16LE(i * 2);
      sumSq += s * s;
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0;

    let targetDuck: number;
    if (rms >= this.loudRms) {
      this.sinceLoudS = 0.0;
      targetDuck = this.duckLinear;
    } else {
      if (this.sinceLoudS !== null) {
        this.sinceLoudS += sampleCount / this.sampleRate;
      }
      if (this.sinceLoudS === null) {
        targetDuck = 1.0;
      } else if (this.sinceLoudS <= this.holdS) {
        targetDuck = this.duckLinear;
      } else {
        const frac = Math.min(1.0, (this.sinceLoudS - this.holdS) / this.releaseS);
        targetDuck = Math.pow(this.duckLinear, 1.0 - frac);
      }
    }

    const baseGain = Math.pow(10, (this.levelDb + REF_LUFS - SBR_DB - BED_LUFS) / 20.0);
    const out = Buffer.allocUnsafe(sampleCount * 2);
    const startDuck = this.currentDuckGain;
    const duckStep = (targetDuck - startDuck) / sampleCount;

    for (let i = 0; i < sampleCount; i++) {
      const agentSample = agentPcm.readInt16LE(i * 2);
      const duckGain = startDuck + duckStep * (i + 1);
      const bedSample = loop[this.pos] * baseGain * duckGain * 32768.0;
      this.pos = (this.pos + 1) % loop.length;

      const mixed = Math.max(-32768, Math.min(32767, Math.round(agentSample + bedSample)));
      out.writeInt16LE(mixed, i * 2);
    }

    this.currentDuckGain = targetDuck;
    return out;
  }
}
