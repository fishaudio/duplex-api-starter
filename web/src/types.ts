export interface VoiceOption {
  id: string;
  gender: string;
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
}

export interface MetaResponse {
  voices: VoiceOption[];
  models: GeminiModelOption[];
  menu: MenuItem[];
  default_realtime_url: string;
  has_fish_api_key: boolean;
  has_vertex_credentials: boolean;
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
  tier?: string;
  traffic_type?: string;
  ttft_ms?: number;
  total_ms?: number;
  sample_reply?: string;
}
