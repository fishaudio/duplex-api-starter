/**
 * Browser AudioWorklets for Fish Audio Realtime:
 *  1. `pcm-capture-processor`: packs mono mic samples into exact 20 ms `pcm_s16le` chunks
 *     and reports RMS dBFS every 100 ms.
 *  2. `pcm-playback-processor`: ~260 ms pre-buffered ring queue eliminating network jitter,
 *     with 4 ms underrun ramps and an 80 ms raised-cosine fade-out on caller barge-in (`flush`).
 */

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = (options && options.processorOptions && options.processorOptions.sampleRate) || sampleRate;
    this.frameSamples = Math.round(sr * 0.02); // 20 ms chunk
    this.buf = new Int16Array(this.frameSamples);
    this.fill = 0;
    this.sumSq = 0;
    this.count = 0;
    this.meterEvery = Math.round(sr * 0.1);
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0] ? inputs[0][0] : null;
    const len = ch ? ch.length : 128;
    for (let i = 0; i < len; i++) {
      const s = ch ? Math.max(-1, Math.min(1, ch[i])) : 0;
      this.sumSq += s * s;
      this.count++;
      this.buf[this.fill++] = s < 0 ? s * 32768 : s * 32767;

      if (this.fill >= this.frameSamples) {
        const copy = new Int16Array(this.buf);
        this.port.postMessage({ type: "pcm", buffer: copy.buffer }, [copy.buffer]);
        this.fill = 0;
      }
    }

    if (this.count >= this.meterEvery) {
      const rms = Math.sqrt(this.sumSq / this.count);
      const db = rms > 1e-5 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
      this.port.postMessage({ type: "meter", db });
      this.sumSq = 0;
      this.count = 0;
    }
    return true;
  }
}

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = (options && options.processorOptions && options.processorOptions.sampleRate) || sampleRate;
    this.capacity = sr * 8; // 8-second ring buffer
    this.ring = new Float32Array(this.capacity);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.available = 0;

    this.prebufferSamples = Math.round(sr * 0.24); // 240 ms jitter cushion
    this.buffering = true;
    this.gain = 0;
    this.fadeStep = 1 / Math.max(1, Math.round(sr * 0.004));

    // 80 ms smooth fade-out when caller barges in
    this.flushTotal = Math.round(sr * 0.08);
    this.flushLeft = 0;

    this.sumSq = 0;
    this.count = 0;
    this.meterEvery = Math.round(sr * 0.1);

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === "enqueue") {
        const pcm16 = new Int16Array(msg.buffer);
        for (let i = 0; i < pcm16.length; i++) {
          if (this.available >= this.capacity) {
            this.readIdx = (this.readIdx + 1) % this.capacity;
            this.available--;
          }
          this.ring[this.writeIdx] = pcm16[i] / 32768.0;
          this.writeIdx = (this.writeIdx + 1) % this.capacity;
          this.available++;
        }
      } else if (msg.type === "flush") {
        if (this.available > 0) {
          this.flushLeft = Math.min(this.available, this.flushTotal);
        }
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
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
      this.count++;
    }

    if (this.count >= this.meterEvery) {
      const rms = Math.sqrt(this.sumSq / this.count);
      const db = rms > 1e-5 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
      this.port.postMessage({
        type: "meter",
        db,
        bufferedMs: Math.round((this.available / sampleRate) * 1000),
      });
      this.sumSq = 0;
      this.count = 0;
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
registerProcessor("pcm-playback-processor", PcmPlaybackProcessor);
