import { useCallback, useEffect, useRef, useState } from "react";

export interface DeviceLists {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

interface AudioContextWithSink extends AudioContext {
  setSinkId?: (sinkId: string) => Promise<void>;
}

export function useAudioRig() {
  const [devices, setDevices] = useState<DeviceLists>({ inputs: [], outputs: [] });
  const [inputDeviceId, setInputDeviceId] = useState<string>("default");
  const [outputDeviceId, setOutputDeviceId] = useState<string>("default");
  const [echoCancel, setEchoCancel] = useState<boolean>(true);
  const [micDb, setMicDb] = useState<number>(-90);
  const [spkDb, setSpkDb] = useState<number>(-90);
  const [bufferedMs, setBufferedMs] = useState<number>(0);

  const ctxRef = useRef<AudioContextWithSink | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playbackNodeRef = useRef<AudioWorkletNode | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices({
      inputs: all.filter((d) => d.kind === "audioinput"),
      outputs: all.filter((d) => d.kind === "audiooutput"),
    });
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [refreshDevices]);

  const startRig = useCallback(
    async (sampleRate: number, onMicPcm: (pcmBuffer: ArrayBuffer) => void) => {
      const ctx = new AudioContext({ sampleRate }) as AudioContextWithSink;
      ctxRef.current = ctx;

      if (outputDeviceId && outputDeviceId !== "default" && typeof ctx.setSinkId === "function") {
        try {
          await ctx.setSinkId(outputDeviceId);
        } catch {
          // Ignore if browser restricts sink selection
        }
      }

      await ctx.audioWorklet.addModule("/audio-worklets.js");

      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: inputDeviceId && inputDeviceId !== "default" ? { exact: inputDeviceId } : undefined,
          channelCount: 1,
          sampleRate,
          echoCancellation: echoCancel,
          noiseSuppression: echoCancel,
          autoGainControl: true,
        },
      };

      const micStream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = micStream;
      await refreshDevices();

      const source = ctx.createMediaStreamSource(micStream);
      const captureNode = new AudioWorkletNode(ctx, "pcm-capture-processor", {
        processorOptions: { sampleRate },
      });
      captureNode.port.onmessage = (ev: MessageEvent) => {
        if (ev.data.type === "pcm") {
          onMicPcm(ev.data.buffer as ArrayBuffer);
        } else if (ev.data.type === "meter") {
          setMicDb(ev.data.db as number);
        }
      };
      source.connect(captureNode);

      const playbackNode = new AudioWorkletNode(ctx, "pcm-playback-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { sampleRate },
      });
      playbackNode.port.onmessage = (ev: MessageEvent) => {
        if (ev.data.type === "meter") {
          setSpkDb(ev.data.db as number);
          setBufferedMs(ev.data.bufferedMs as number);
        }
      };
      playbackNode.connect(ctx.destination);
      playbackNodeRef.current = playbackNode;

      if (ctx.state === "suspended") {
        await ctx.resume();
      }
    },
    [echoCancel, inputDeviceId, outputDeviceId, refreshDevices],
  );

  const enqueueSpeakerPcm = useCallback((pcmBuffer: ArrayBuffer) => {
    playbackNodeRef.current?.port.postMessage({ type: "enqueue", buffer: pcmBuffer }, [pcmBuffer]);
  }, []);

  const flushSpeaker = useCallback(() => {
    playbackNodeRef.current?.port.postMessage({ type: "flush" });
  }, []);

  const stopRig = useCallback(async () => {
    playbackNodeRef.current?.disconnect();
    playbackNodeRef.current = null;
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
    enqueueSpeakerPcm,
    flushSpeaker,
    stopRig,
  };
}
