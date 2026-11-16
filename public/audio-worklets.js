/**
 * Browser AudioWorklets for Fish Audio Realtime:
 *
 *  1. `pcm-capture-processor`: runs at native AudioContext hardware rate (e.g. 48 kHz),
 *     box-averages + resamples cleanly to `targetSampleRate` (e.g. 24 kHz), and emits exact
 *     20 ms `pcm_s16le` frames.
 *  2. `pcm-playback-processor`: smooth 300 ms jitter buffer tailored for live-3's ~186 ms
 *     block bursts:
 *       - Prebuffers 300 ms ONCE at session start (or after barge-in flush).
 *       - Never stalls/re-buffers for 300 ms on brief jitter spikes: late bursts play
 *         immediately (naturally growing the playout cushion by the exact spike duration)
 *         with 4 ms raised-edge ramps on tail & onset so there are zero clicks or chops.
 *       - Smooth 80 ms raised-cosine fade-out on caller barge-in (`flush`).
 */

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetSampleRate || 24000;
    this.inRate = sampleRate;
    this.ratio = this.inRate / this.targetRate;

    this.frameSamples = Math.round(this.targetRate * 0.02);
    this.outBuf = new Int16Array(this.frameSamples);
    this.outFill = 0;

    this.inPos = 0;
    this.accSum = 0;
    this.accCount = 0;

    this.sumSq = 0;
    this.meterCount = 0;
    this.meterEvery = Math.round(this.inRate * 0.08);
  }

  process(inputs, outputs) {
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

    this.capacity = this.hwRate * 12; // 12-second ring buffer in hardware frames
    this.ring = new Float32Array(this.capacity);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.available = 0;
    this.prevInSample = 0;
    this.resamplePhase = 0;

    // 300 ms initial cushion covers live-3's ~186 ms block bursts + network jitter
    this.prebufferSamples = Math.round(this.hwRate * 0.3);
    this.maxBufferSamples = Math.round(this.hwRate * 1.4);
    this.targetAfterTrim = Math.round(this.hwRate * 0.4);
    this.initialBuffering = true;

    // 4 ms anti-click edge ramp on underrun tail and recovery onset
    this.fadeSamples = Math.max(1, Math.round(this.hwRate * 0.004));
    this.fadeStep = 1 / this.fadeSamples;
    this.gain = 0;

    // 80 ms smooth raised-cosine fade-out on caller barge-in (`flush`)
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
      this.initialBuffering = false;
    }

    if (this.streamRate === this.hwRate) {
      for (let i = 0; i < pcm16.length; i++) {
        this.pushHwSample(pcm16[i] / 32768.0);
      }
    } else {
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

    // Bound runaway latency if browser tab was background-stalled > 1.4 s
    if (this.available > this.maxBufferSamples && this.flushLeft === 0) {
      const drop = this.available - this.targetAfterTrim;
      this.readIdx = (this.readIdx + drop) % this.capacity;
      this.available -= drop;
      this.gain = 0; // 4 ms smooth ramp-in from new read position
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0] ? outputs[0][0] : null;
    if (!out) return true;

    if (this.initialBuffering && this.available >= this.prebufferSamples) {
      this.initialBuffering = false;
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
          this.initialBuffering = true;
          this.gain = 0;
        }
      } else if (!this.initialBuffering && this.available > 0) {
        const raw = this.ring[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.available--;

        // Smooth 4 ms fade-in after startup/gap, and 4 ms fade-out if draining near 0
        this.gain = Math.min(1, this.gain + this.fadeStep);
        const tailFade = this.available < this.fadeSamples ? this.available / this.fadeSamples : 1;
        sample = raw * Math.min(this.gain, tailFade);
        if (this.available === 0) {
          this.gain = 0;
        }
      } else {
        // Initial prebuffer OR brief late-packet gap (do NOT set initialBuffering=true here!)
        this.gain = 0;
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
