import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AuthScheme, ConfigValidation } from "../shared/types.ts";

export interface AppConfig {
  server: {
    port: number;
  };
  fish_realtime: {
    endpoint: string;
    auth_scheme: AuthScheme;
    token: string;
    username: string;
    password: string;
    reference_id: string;
  };
  vertex_ai: {
    credentials_path: string;
    location: string;
    default_model: string;
    default_tier: "priority" | "normal";
  };
  ambience: {
    enabled: boolean;
    level_db: number;
  };
}

const DEFAULT_CONFIG: AppConfig = {
  server: { port: 8080 },
  fish_realtime: {
    endpoint: "wss://api.fish.audio/v1/realtime/converse",
    auth_scheme: "bearer",
    token: "",
    username: "",
    password: "",
    reference_id: "",
  },
  vertex_ai: {
    credentials_path: "",
    location: "global",
    default_model: "gemini-3.5-flash-lite",
    default_tier: "priority",
  },
  ambience: {
    enabled: true,
    level_db: 0.0,
  },
};

export function resolveConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.STARTER_CONFIG_PATH) return path.resolve(process.env.STARTER_CONFIG_PATH);
  return path.resolve(process.cwd(), "config.toml");
}

export function loadAndValidateConfig(overridePath?: string): {
  config: AppConfig;
  validation: ConfigValidation;
} {
  const configPath = resolveConfigPath(overridePath);
  const exists = fs.existsSync(configPath);

  let raw: Record<string, unknown> = {};
  if (exists) {
    try {
      raw = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      return {
        config: DEFAULT_CONFIG,
        validation: {
          ready: false,
          configPath,
          configFileExists: true,
          missingFields: [`Invalid TOML syntax in config.toml: ${String(err)}`],
          endpoint: DEFAULT_CONFIG.fish_realtime.endpoint,
          authScheme: DEFAULT_CONFIG.fish_realtime.auth_scheme,
          defaultReferenceId: DEFAULT_CONFIG.fish_realtime.reference_id,
          defaultModel: DEFAULT_CONFIG.vertex_ai.default_model,
          defaultTier: DEFAULT_CONFIG.vertex_ai.default_tier,
          ambienceEnabled: DEFAULT_CONFIG.ambience.enabled,
          ambienceLevelDb: DEFAULT_CONFIG.ambience.level_db,
        },
      };
    }
  }

  const srv = (raw.server ?? {}) as Record<string, unknown>;
  const fr = (raw.fish_realtime ?? {}) as Record<string, unknown>;
  const vx = (raw.vertex_ai ?? {}) as Record<string, unknown>;
  const amb = (raw.ambience ?? {}) as Record<string, unknown>;

  const authScheme: AuthScheme = fr.auth_scheme === "basic" ? "basic" : "bearer";
  const defaultTier = vx.default_tier === "normal" ? "normal" : "priority";

  const config: AppConfig = {
    server: {
      port: Number(srv.port ?? process.env.PORT ?? 8080),
    },
    fish_realtime: {
      endpoint: String(fr.endpoint ?? DEFAULT_CONFIG.fish_realtime.endpoint).trim(),
      auth_scheme: authScheme,
      token: String(fr.token ?? "").trim(),
      username: String(fr.username ?? "").trim(),
      password: String(fr.password ?? "").trim(),
      reference_id: String(fr.reference_id ?? "").trim(),
    },
    vertex_ai: {
      credentials_path: String(vx.credentials_path ?? "").trim(),
      location: String(vx.location ?? "global").trim() || "global",
      default_model: String(vx.default_model ?? "gemini-3.5-flash-lite").trim(),
      default_tier: defaultTier,
    },
    ambience: {
      enabled: amb.enabled !== undefined ? Boolean(amb.enabled) : true,
      level_db: Number(amb.level_db ?? 0),
    },
  };

  const missingFields: string[] = [];
  if (!exists) {
    missingFields.push("config.toml file not found (run: cp config.example.toml config.toml)");
  } else {
    if (!config.fish_realtime.endpoint.startsWith("ws")) {
      missingFields.push("fish_realtime.endpoint (must start with wss:// or ws://)");
    }
    if (config.fish_realtime.auth_scheme === "bearer") {
      if (!config.fish_realtime.token || config.fish_realtime.token.includes("your_")) {
        missingFields.push("fish_realtime.token (required when auth_scheme = 'bearer')");
      }
    } else {
      if (!config.fish_realtime.username || !config.fish_realtime.password) {
        missingFields.push("fish_realtime.username & fish_realtime.password (required when auth_scheme = 'basic')");
      }
    }
    if (!config.vertex_ai.credentials_path) {
      missingFields.push("vertex_ai.credentials_path (path to GCP Service Account JSON)");
    } else if (!fs.existsSync(config.vertex_ai.credentials_path)) {
      missingFields.push(`vertex_ai.credentials_path does not exist on disk: ${config.vertex_ai.credentials_path}`);
    }
  }

  return {
    config,
    validation: {
      ready: missingFields.length === 0,
      configPath,
      configFileExists: exists,
      missingFields,
      endpoint: config.fish_realtime.endpoint,
      authScheme: config.fish_realtime.auth_scheme,
      defaultReferenceId: config.fish_realtime.reference_id,
      defaultModel: config.vertex_ai.default_model,
      defaultTier: config.vertex_ai.default_tier,
      ambienceEnabled: config.ambience.enabled,
      ambienceLevelDb: config.ambience.level_db,
    },
  };
}

export function buildAuthHeader(opts: {
  authScheme: AuthScheme;
  token?: string;
  username?: string;
  password?: string;
}): string | undefined {
  if (opts.authScheme === "basic") {
    if (!opts.username && !opts.password) return undefined;
    const encoded = Buffer.from(`${opts.username ?? ""}:${opts.password ?? ""}`).toString("base64");
    return `Basic ${encoded}`;
  }
  const tok = (opts.token ?? "").trim();
  return tok ? `Bearer ${tok}` : undefined;
}
