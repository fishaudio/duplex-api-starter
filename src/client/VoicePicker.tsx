import { useState } from "react";
import { DEFAULT_VOICE_REFERENCE_ID, VOICE_PRESETS } from "../shared/voices";

interface VoicePickerProps {
  value: string;
  onChange: (referenceId: string) => void;
  disabled?: boolean;
}

export function VoicePicker({ value, onChange, disabled }: VoicePickerProps) {
  const [customSelected, setCustomSelected] = useState(false);
  const [customId, setCustomId] = useState("");
  const knownVoice = VOICE_PRESETS.some((voice) => voice.id === value);
  const showCustom = customSelected || !knownVoice;

  return (
    <>
      <div className="field">
        <label htmlFor="voice-preset">Voice</label>
        <select
          id="voice-preset"
          value={showCustom ? "custom" : value}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "custom") {
              setCustomSelected(true);
              onChange(customId);
            } else {
              if (showCustom) setCustomId(value);
              setCustomSelected(false);
              onChange(next);
            }
          }}
        >
          {VOICE_PRESETS.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}{voice.id === DEFAULT_VOICE_REFERENCE_ID ? " (Default)" : ""}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </div>
      {showCustom && (
        <div className="field">
          <label htmlFor="custom-voice-id">Custom Voice ID</label>
          <input
            id="custom-voice-id"
            type="text"
            value={value}
            onChange={(event) => {
              setCustomId(event.target.value);
              onChange(event.target.value);
            }}
            placeholder="Voice ID (empty = service default)"
            title="Fish Voice Library reference ID. Leave empty to use the service default."
            disabled={disabled}
          />
        </div>
      )}
    </>
  );
}
