import { useCallback, useEffect, useRef, useState } from "react";

export interface DeviceLists {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

function dedupeHardwareDevices(list: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const seenGroupNames = new Set<string>();
  return list.filter((d) => {
    if (!d.deviceId || d.deviceId === "default" || d.deviceId === "communications") {
      return false;
    }
    const key = `${d.kind}:${d.label || d.deviceId}`;
    if (seenGroupNames.has(key)) return false;
    seenGroupNames.add(key);
    return true;
  });
}

export function useAudioRig() {
  const [devices, setDevices] = useState<DeviceLists>({ inputs: [], outputs: [] });
  const [inputDeviceId, setInputDeviceIdState] = useState<string>("default");
  const [outputDeviceId, setOutputDeviceIdState] = useState<string>("default");
  const [echoCancel, setEchoCancel] = useState<boolean>(true);
  const [micDb, setMicDb] = useState<number>(-90);
  const [spkDb, setSpkDb] = useState<number>(-90);
  const [bufferedMs, setBufferedMs] = useState<number>(0);

  const inputDeviceIdRef = useRef<string>("default");
  const outputDeviceIdRef = useRef<string>("default");
  const echoCancelRef = useRef<boolean>(true);
  echoCancelRef.current = echoCancel;

  // Hold EVERY WebAudio node & HTMLAudioElement in refs so Chromium GC never collects active nodes!
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const captureNodeRef = useRef<AudioWorkletNode | null>(null);
  const zeroGainRef = useRef<GainNode | null>(null);
  const playbackNodeRef = useRef<AudioWorkletNode | null>(null);
  const mediaDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices({
      inputs: dedupeHardwareDevices(all.filter((d) => d.kind === "audioinput")),
      outputs: dedupeHardwareDevices(all.filter((d) => d.kind === "audiooutput")),
    });
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [refreshDevices]);

  // Route playbackNode either directly to ctx.destination ("default") or via HTMLAudioElement.setSinkId
  const applySpeakerRouting = useCallback(async (sinkId: string) => {
    const ctx = ctxRef.current;
    const playbackNode = playbackNodeRef.current;
    const zeroGain = zeroGainRef.current;
    if (!ctx || !playbackNode || !zeroGain) return;

    playbackNode.disconnect();
    // Always keep a 0-gain connection to ctx.destination so Chromium's graph clock pulls playbackNode!
    playbackNode.connect(zeroGain);

    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.srcObject = null;
      audioElRef.current.remove();
      audioElRef.current = null;
    }

    if (!sinkId || sinkId === "default") {
      playbackNode.connect(ctx.destination);
      return;
    }

    const mediaDest = mediaDestRef.current ?? ctx.createMediaStreamDestination();
    mediaDestRef.current = mediaDest;
    playbackNode.connect(mediaDest);

    const audioEl = document.createElement("audio");
    audioEl.style.display = "none";
    audioEl.autoplay = true;
    audioEl.setAttribute("playsinline", "true");
    document.body.appendChild(audioEl);
    audioEl.srcObject = mediaDest.stream;
    if ("setSinkId" in audioEl && typeof audioEl.setSinkId === "function") {
      await audioEl.setSinkId(sinkId);
    }
    await audioEl.play();
    audioElRef.current = audioEl;
  }, []);

  const openMicIntoCapture = useCallback(
    async (micId: string, useAec: boolean) => {
      const ctx = ctxRef.current;
      const captureNode = captureNodeRef.current;
      if (!ctx || !captureNode) return;

      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
        micSourceRef.current = null;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;

      // Do NOT force sampleRate in getUserMedia — let macOS CoreAudio open native rate & resample in worklet
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micId && micId !== "default" ? { exact: micId } : undefined,
          channelCount: 1,
          echoCancellation: useAec,
          noiseSuppression: useAec,
          autoGainControl: true,
        },
      });
      streamRef.current = micStream;
      await refreshDevices();

      const source = ctx.createMediaStreamSource(micStream);
      source.connect(captureNode);
      micSourceRef.current = source;
    },
    [refreshDevices],
  );

  // Hot-swap Microphone mid-call when user picks another device
  const setInputDeviceId = useCallback(
    (nextId: string) => {
      inputDeviceIdRef.current = nextId;
      setInputDeviceIdState(nextId);
      if (ctxRef.current && captureNodeRef.current) {
        void openMicIntoCapture(nextId, echoCancelRef.current).catch(console.error);
      }
    },
    [openMicIntoCapture],
  );

  // Hot-swap Speaker Output mid-call when user picks another device
  const setOutputDeviceId = useCallback(
    (nextId: string) => {
      outputDeviceIdRef.current = nextId;
      setOutputDeviceIdState(nextId);
      if (ctxRef.current && playbackNodeRef.current) {
        void applySpeakerRouting(nextId).catch(console.error);
      }
    },
    [applySpeakerRouting],
  );

  const stopRig = useCallback(async () => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.srcObject = null;
      audioElRef.current.remove();
      audioElRef.current = null;
    }
    micSourceRef.current?.disconnect();
    micSourceRef.current = null;
    captureNodeRef.current?.disconnect();
    captureNodeRef.current = null;
    playbackNodeRef.current?.disconnect();
    playbackNodeRef.current = null;
    zeroGainRef.current?.disconnect();
    zeroGainRef.current = null;
    mediaDestRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    if (ctxRef.current) {
      await ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
    setMicDb(-90);
    setSpkDb(-90);
    setBufferedMs(0);
  }, []);

  const startRig = useCallback(
    async (targetSampleRate: number, onMicPcm?: (pcmBuffer: ArrayBuffer) => void) => {
      // Create & resume AudioContext synchronously inside user click gesture at native hardware rate!
      const prevCtx = ctxRef.current;
      if (prevCtx) {
        await stopRig();
      }
      const ctx = new AudioContext({ latencyHint: "interactive" });
      void ctx.resume();
      ctxRef.current = ctx;

      await ctx.audioWorklet.addModule("/audio-worklets.js");

      // Zero-gain sink connected to ctx.destination keeps captureNode & playbackNode pulled by WebAudio!
      const zeroGain = ctx.createGain();
      zeroGain.gain.value = 0;
      zeroGain.connect(ctx.destination);
      zeroGainRef.current = zeroGain;

      const captureNode = new AudioWorkletNode(ctx, "pcm-capture-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetSampleRate },
      });
      captureNode.port.onmessage = (ev: MessageEvent) => {
        if (ev.data.type === "pcm") {
          onMicPcm?.(ev.data.buffer as ArrayBuffer);
        } else if (ev.data.type === "meter") {
          setMicDb(ev.data.db as number);
        }
      };
      captureNode.connect(zeroGain);
      captureNodeRef.current = captureNode;

      const playbackNode = new AudioWorkletNode(ctx, "pcm-playback-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { streamSampleRate: targetSampleRate },
      });
      playbackNode.port.onmessage = (ev: MessageEvent) => {
        if (ev.data.type === "meter") {
          setSpkDb(ev.data.db as number);
          setBufferedMs(ev.data.bufferedMs as number);
        }
      };
      playbackNodeRef.current = playbackNode;

      await applySpeakerRouting(outputDeviceIdRef.current);
      await openMicIntoCapture(inputDeviceIdRef.current, echoCancelRef.current);

      if (ctx.state !== "running") {
        await ctx.resume();
      }
    },
    [applySpeakerRouting, openMicIntoCapture, stopRig],
  );

  const setServerOutputRate = useCallback((streamSampleRate: number) => {
    playbackNodeRef.current?.port.postMessage({ type: "setStreamRate", streamSampleRate });
  }, []);

  const enqueueSpeakerPcm = useCallback((pcmBuffer: ArrayBuffer, immediate = false) => {
    playbackNodeRef.current?.port.postMessage(
      { type: "enqueue", buffer: pcmBuffer, immediate },
      [pcmBuffer],
    );
  }, []);

  const flushSpeaker = useCallback(() => {
    playbackNodeRef.current?.port.postMessage({ type: "flush" });
  }, []);

  // Quick 2-second hardware check: plays a pleasant two-tone chime to selected Speaker & shows Mic meter!
  const testAudioHardware = useCallback(async () => {
    const alreadyLive = ctxRef.current !== null;
    if (!alreadyLive) {
      await startRig(24000);
    }
    const sr = 24000;
    const durSamples = Math.round(sr * 0.36);
    const chime = new Int16Array(durSamples);
    for (let i = 0; i < durSamples; i++) {
      const t = i / sr;
      const freq = t < 0.18 ? 523.25 : 659.25; // C5 -> E5 chime
      const env = Math.sin(Math.PI * ((t % 0.18) / 0.18));
      chime[i] = Math.round(Math.sin(2 * Math.PI * freq * t) * env * 9000);
    }
    enqueueSpeakerPcm(chime.buffer, true);

    if (!alreadyLive) {
      await new Promise((r) => setTimeout(r, 2500));
      if (ctxRef.current && !alreadyLive) {
        await stopRig();
      }
    }
  }, [enqueueSpeakerPcm, startRig, stopRig]);

  return {
    devices,
    inputDeviceId,
    setInputDeviceId,
    outputDeviceId,
    setOutputDeviceId,
    echoCancel,
    setEchoCancel,
    micDb,
    spkDb,
    bufferedMs,
    refreshDevices,
    startRig,
    setServerOutputRate,
    enqueueSpeakerPcm,
    flushSpeaker,
    stopRig,
    testAudioHardware,
  };
}
