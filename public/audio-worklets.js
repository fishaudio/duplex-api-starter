/**
 * Browser AudioWorklets for Fish Audio Realtime (Hardware-Rate Safe):
 *
 * Both processors run at the AudioContext's native hardware sampleRate (typically 48,000 Hz on macOS)
 * and resample cleanly inside the worklet to/from the Fish session sampleRate (e.g. 24,000 Hz).
 * Running AudioContext at native hardware rate avoids Chromium/CoreAudio stalls when pairing
 * 48 kHz USB microphones with custom output devices.
 */

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetSampleRate || 24000;
    this.inRate = sampleRate; // WebAudio global hardware rate (e.g. 48000)
    this.ratio = this.inRate / this.targetRate;

    this.frameSamples = Math.round(this.targetRate * 0.02); // Exact 20 ms chunk
    this.outBuf = new Int16Array(this.frameSamples);
    this.outFill = 0;

    // Fractional resampler state with box-averaging anti-alias accumulator
    this.inPos = 0;
    this.accSum = 0;
    this.accCount = 0;

    this.sumSq = 0;
    this.meterCount = 0;
    this.meterEvery = Math.round(this.inRate * 0.08);
  }

  process(inputs, outputs) {
    // Keep downstream zero-gain pull active
    if (outputs[0] && outputs[0][0]) {
      outputs[0][0].fill(0);
    }

    const inputChan = inputs[0] && inputs[0][0] ? inputs[0][0] : null;
    const len = inputChan ? inputChan.length : 128;

    for (let i = 0; i < len; i++) {
      const s = inputChan ? Math.max(-1, Math.min(1, inputChan[i])) : 0;
      this.sumSq += s * s;
      this.meterCount++;

      this.accSum += s;
      this.accCount++;
      this.inPos += 1;

      if (this.inPos >= this.ratio) {
        this.inPos -= this.ratio;
        const avg = this.accCount > 0 ? this.accSum / this.accCount : s;
        this.accSum = 0;
        this.accCount = 0;

        const clamped = Math.max(-1, Math.min(1, avg));
        this.outBuf[this.outFill++] = clamped < 0 ? clamped * 32768 : clamped * 32767;

        if (this.outFill >= this.frameSamples) {
          const copy = new Int16Array(this.outBuf);
          this.port.postMessage({ type: "pcm", buffer: copy.buffer }, [copy.buffer]);
          this.outFill = 0;
        }
      }
    }

    if (this.meterCount >= this.meterEvery) {
      const rms = Math.sqrt(this.sumSq / this.meterCount);
      const db = rms > 1e-5 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
      this.port.postMessage({ type: "meter", db });
      this.sumSq = 0;
      this.meterCount = 0;
    }

    return true;
  }
}

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.streamRate = opts.streamSampleRate || 24000;
    this.hwRate = sampleRate;

    this.capacity = this.hwRate * 10; // 10-second ring buffer in hardware frames
    this.ring = new Float32Array(this.capacity);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.available = 0;
    this.prevInSample = 0;
    this.resamplePhase = 0;

    this.prebufferSamples = Math.round(this.hwRate * 0.22); // 220 ms jitter cushion
    this.buffering = true;
    this.gain = 0;
    this.fadeStep = 1 / Math.max(1, Math.round(this.hwRate * 0.004));

    this.flushTotal = Math.round(this.hwRate * 0.08);
    this.flushLeft = 0;

    this.sumSq = 0;
    this.meterCount = 0;
    this.meterEvery = Math.round(this.hwRate * 0.08);

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === "setStreamRate" && msg.streamSampleRate > 0) {
        this.streamRate = msg.streamSampleRate;
      } else if (msg.type === "enqueue") {
        const pcm16 = new Int16Array(msg.buffer);
        this.enqueueResampled(pcm16, msg.immediate === true);
      } else if (msg.type === "flush") {
        if (this.available > 0) {
          this.flushLeft = Math.min(this.available, this.flushTotal);
        }
      }
    };
  }

  pushHwSample(val) {
    if (this.available >= this.capacity) {
      this.readIdx = (this.readIdx + 1) % this.capacity;
      this.available--;
    }
    this.ring[this.writeIdx] = val;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    this.available++;
  }

  enqueueResampled(pcm16, immediate) {
    if (pcm16.length === 0) return;
    if (immediate) {
      this.buffering = false;
    }
    if (this.streamRate === this.hwRate) {
      for (let i = 0; i < pcm16.length; i++) {
        this.pushHwSample(pcm16[i] / 32768.0);
      }
      return;
    }

    // Linear interpolation from streamRate -> hwRate
    const step = this.streamRate / this.hwRate;
    let prev = this.prevInSample;
    let pos = this.resamplePhase;

    for (let i = 0; i < pcm16.length; i++) {
      const curr = pcm16[i] / 32768.0;
      while (pos < 1.0) {
        const interp = prev + (curr - prev) * pos;
        this.pushHwSample(interp);
        pos += step;
      }
      pos -= 1.0;
      prev = curr;
    }
    this.prevInSample = prev;
    this.resamplePhase = pos;
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0] ? outputs[0][0] : null;
    if (!out) return true;

    if (this.buffering && this.available >= this.prebufferSamples) {
      this.buffering = false;
    }

    for (let i = 0; i < out.length; i++) {
      let sample = 0;
      if (this.flushLeft > 0) {
        const raw = this.ring[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.available--;
        const progress = 1 - this.flushLeft / this.flushTotal;
        const cosGain = 0.5 * (1 + Math.cos(Math.PI * progress));
        sample = raw * cosGain;
        this.flushLeft--;
        if (this.flushLeft === 0) {
          this.readIdx = this.writeIdx;
          this.available = 0;
          this.buffering = true;
          this.gain = 0;
        }
      } else if (!this.buffering && this.available > 0) {
        sample = this.ring[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.available--;
        this.gain = Math.min(1, this.gain + this.fadeStep);
        sample *= this.gain;
      } else {
        this.buffering = true;
        this.gain = Math.max(0, this.gain - this.fadeStep);
        sample = 0;
      }

      out[i] = sample;
      this.sumSq += sample * sample;
      this.meterCount++;
    }

    if (this.meterCount >= this.meterEvery) {
      const rms = Math.sqrt(this.sumSq / this.meterCount);
      const db = rms > 1e-5 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
      this.port.postMessage({
        type: "meter",
        db,
        bufferedMs: Math.round((this.available / this.hwRate) * 1000),
      });
      this.sumSq = 0;
      this.meterCount = 0;
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
registerProcessor("pcm-playback-processor", PcmPlaybackProcessor);
