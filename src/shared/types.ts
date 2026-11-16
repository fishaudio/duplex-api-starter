export interface VoiceOption {
  id: string;
  gender: "F" | "M";
  label: string;
}

export interface GeminiModelOption {
  id: string;
  label: string;
}

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  daypart: "regular" | "breakfast" | "all";
  price: number;
  meal_add?: number;
  sizes?: Record<string, number>;
}

export type AuthScheme = "bearer" | "basic";

export interface ConfigValidation {
  ready: boolean;
  configPath: string;
  configFileExists: boolean;
  missingFields: string[];
  endpoint: string;
  authScheme: AuthScheme;
  defaultVoice: string;
  defaultModel: string;
  defaultTier: "priority" | "normal";
  ambienceEnabled: boolean;
  ambienceLevelDb: number;
}

export interface MetaResponse {
  voices: VoiceOption[];
  models: GeminiModelOption[];
  menu: MenuItem[];
  configStatus: ConfigValidation;
}

export interface OrderLine {
  line: number;
  item_id: string;
  name: string;
  qty: number;
  size: string;
  meal: boolean;
  drink: string;
  modifiers: string[];
  unit_price: number;
  line_total: number;
}

export interface OrderSnapshot {
  daypart: "regular" | "breakfast";
  status: "open" | "confirmed" | "cancelled";
  order_number: number;
  lines: OrderLine[];
  subtotal: number;
  tax: number;
  total: number;
}

export interface InspectorEvent {
  id: number;
  ts: string;
  channel: string;
  type: string;
  seq?: number;
  payload: Record<string, unknown>;
}

export interface GeminiPingResult {
  ok: boolean;
  error?: string;
  project_id?: string;
  model?: string;
  tier?: "priority" | "normal";
  traffic_type?: string;
  ttft_ms?: number;
  total_ms?: number;
  sample_reply?: string;
}

export interface TextRules {
  numbers?: "spoken" | "written" | string;
  tags?: string[] | string | boolean;
  ack_in_t?: boolean;
  avoid?: string[] | string;
}
