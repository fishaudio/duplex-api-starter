"""Backend Ambience Bed Mixer + Speech Ducker (adapted from live3-agent/phone/bed.py).

Why mix ambience on the backend instead of the browser?
In production telephony (SIP / Twilio / WebRTC) and web calls alike, mixing the scenario's
ambient environment (kitchen fryer + speaker post for a drive-thru, call-center room tone for
support) on the backend into the outbound PCM stream ensures:
  1. Every caller hears a continuous, living phone line even while the LLM thinks or runs tools.
  2. Sidechain ducking (-10 dB when the agent speaks, 100 ms hold, 300 ms release) keeps the
     agent's voice crisp and intelligible above background noise without pumping between words.
  3. Caller ASR never hears the ambience because only the outbound speaker path is mixed.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import numpy as np
import miniaudio

ASSETS_DIR = Path(__file__).with_name("assets")
DRIVE_THRU_MP3 = ASSETS_DIR / "drive_thru.mp3"

# Calibration constants matching live3-agent beds.json:
# agent speech ~ -20.0 LUFS, drive_thru.mp3 = -30.44 LUFS, target speech-to-bed ratio = 25.0 dB
REF_LUFS = -20.0
BED_LUFS = -30.44
SBR_DB = 25.0


def _prepare_seamless_loop(samples: np.ndarray, loop_samples: int, xfade_samples: int) -> np.ndarray:
    """Crossfade the loop tail with its head so wrap-around has zero click or discontinuity."""
    if len(samples) <= loop_samples or xfade_samples <= 0:
        return samples
    out = np.empty(loop_samples, dtype=np.float32)
    xf = min(xfade_samples, loop_samples, len(samples) - loop_samples)
    out[xf:] = samples[xf:loop_samples]
    idx = np.arange(xf, dtype=np.float32)
    w = (idx + 0.5) / float(xf)
    out[:xf] = samples[:xf] * w + samples[loop_samples : loop_samples + xf] * (1.0 - w)
    return out


@lru_cache(maxsize=4)
def load_drive_thru_loop(sample_rate: int) -> np.ndarray:
    """Decode drive_thru.mp3 once per sample rate into normalized float32 [-1, 1] mono."""
    decoded = miniaudio.decode_file(
        str(DRIVE_THRU_MP3),
        output_format=miniaudio.SampleFormat.SIGNED16,
        nchannels=1,
        sample_rate=sample_rate,
    )
    pcm = np.frombuffer(decoded.samples, dtype=np.int16).astype(np.float32) / 32768.0
    # 72.0 s loop + 0.5 s crossfade (scaled from 44.1 kHz reference: 3,175,200 & 22,050 samples)
    loop_len = int(72.0 * sample_rate)
    xfade_len = int(0.5 * sample_rate)
    if len(pcm) > loop_len:
        return _prepare_seamless_loop(pcm, loop_len, xfade_len)
    return pcm


class AmbienceMixer:
    """Sample-accurate looping ambience mixer with automatic -10 dB speech sidechain ducking."""

    def __init__(
        self,
        sample_rate: int = 24000,
        enabled: bool = True,
        level_db: float = 0.0,
        duck_db: float = -10.0,
    ) -> None:
        self.sample_rate = sample_rate
        self.enabled = enabled
        self.level_db = level_db
        self._duck_linear = 10.0 ** (duck_db / 20.0)
        self._hold_s = 0.10
        self._release_s = 0.30
        self._loud_rms = 300.0

        self._pos = 0
        self._current_duck_gain = 1.0
        self._since_loud_s: float | None = None
        self._loop = load_drive_thru_loop(sample_rate) if DRIVE_THRU_MP3.exists() else np.zeros(0, dtype=np.float32)

    def set_sample_rate(self, sample_rate: int) -> None:
        if sample_rate != self.sample_rate:
            self.sample_rate = sample_rate
            self._pos = 0
            self._loop = (
                load_drive_thru_loop(sample_rate)
                if DRIVE_THRU_MP3.exists()
                else np.zeros(0, dtype=np.float32)
            )

    def _duck_envelope(self, agent_int16: np.ndarray) -> np.ndarray:
        n = len(agent_int16)
        rms = float(np.sqrt(np.mean(agent_int16.astype(np.float64) ** 2))) if n else 0.0
        if rms >= self._loud_rms:
            self._since_loud_s = 0.0
            target = self._duck_linear
        else:
            if self._since_loud_s is not None:
                self._since_loud_s += n / float(self.sample_rate)
            if self._since_loud_s is None:
                target = 1.0
            elif self._since_loud_s <= self._hold_s:
                target = self._duck_linear
            else:
                frac = min(1.0, (self._since_loud_s - self._hold_s) / self._release_s)
                target = self._duck_linear ** (1.0 - frac)

        env = np.linspace(self._current_duck_gain, target, n + 1, dtype=np.float32)[1:]
        self._current_duck_gain = target
        return env

    def mix_pcm_s16le(self, agent_pcm: bytes) -> bytes:
        """Mix looping drive-thru bed into mono pcm_s16le agent audio."""
        if not self.enabled or len(self._loop) == 0 or len(agent_pcm) < 2:
            return agent_pcm

        agent_arr = np.frombuffer(agent_pcm, dtype=np.int16)
        n = len(agent_arr)

        idx = (self._pos + np.arange(n)) % len(self._loop)
        self._pos = (self._pos + n) % len(self._loop)

        base_gain = 10.0 ** ((self.level_db + REF_LUFS - SBR_DB - BED_LUFS) / 20.0)
        bed = self._loop[idx] * base_gain * self._duck_envelope(agent_arr) * 32768.0

        mixed = np.clip(np.round(agent_arr.astype(np.float32) + bed), -32768, 32767).astype(np.int16)
        return mixed.tobytes()
