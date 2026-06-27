import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SolidusConfig } from "./types.js";
import { DEFAULTS } from "./types.js";
import { ConfigError } from "./errors.js";

export type ConfigSource = "default" | "file" | "env" | "cli";

export interface ResolvedConfig extends SolidusConfig {
  _sources: Record<string, ConfigSource>;
}

const ENV_MAP: Record<string, keyof SolidusConfig> = {
  SOLIDUS_FLAKY_LOW: "flakyThresholdLow",
  SOLIDUS_FLAKY_HIGH: "flakyThresholdHigh",
  SOLIDUS_WINDOW: "windowSize",
  SOLIDUS_MIN_RUNS: "minRuns",
  SOLIDUS_DB_PATH: "dbPath",
  SOLIDUS_AUTO_QUARANTINE: "autoQuarantine",
  SOLIDUS_LOG_LEVEL: "logLevel",
};

function readConfigFile(path: string): Partial<SolidusConfig> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Partial<SolidusConfig>;
  } catch (err) {
    throw new ConfigError(`Failed to parse config file ${path}`, err);
  }
}

function readEnv(): Partial<SolidusConfig> {
  const out: Record<string, unknown> = {};
  for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
    const val = process.env[envKey];
    if (val === undefined) continue;
    switch (configKey) {
      case "flakyThresholdLow":
      case "flakyThresholdHigh": {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0 || n > 1) throw new ConfigError(`${envKey}: must be a number between 0 and 1`);
        out[configKey] = n;
        break;
      }
      case "windowSize":
      case "minRuns": {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1) throw new ConfigError(`${envKey}: must be a positive integer`);
        out[configKey] = n;
        break;
      }
      case "autoQuarantine":
        out[configKey] = val === "true" || val === "1";
        break;
      case "logLevel": {
        if (!["silent", "error", "warn", "info", "debug"].includes(val)) {
          throw new ConfigError(`${envKey}: must be silent|error|warn|info|debug`);
        }
        out[configKey] = val;
        break;
      }
      default:
        out[configKey] = val;
    }
  }
  return out as Partial<SolidusConfig>;
}

function validateConfig(config: Partial<SolidusConfig>): string[] {
  const errors: string[] = [];
  if (config.flakyThresholdLow !== undefined) {
    if (config.flakyThresholdLow < 0 || config.flakyThresholdLow > 1) {
      errors.push("flakyThresholdLow: must be between 0 and 1");
    }
  }
  if (config.flakyThresholdHigh !== undefined) {
    if (config.flakyThresholdHigh < 0 || config.flakyThresholdHigh > 1) {
      errors.push("flakyThresholdHigh: must be between 0 and 1");
    }
  }
  if (config.flakyThresholdLow !== undefined && config.flakyThresholdHigh !== undefined) {
    if (config.flakyThresholdLow >= config.flakyThresholdHigh) {
      errors.push("flakyThresholdLow must be less than flakyThresholdHigh");
    }
  }
  if (config.windowSize !== undefined && (config.windowSize < 2 || !Number.isFinite(config.windowSize))) {
    errors.push("windowSize: minimum is 2 and must be finite");
  }
  if (config.minRuns !== undefined && (config.minRuns < 1 || !Number.isFinite(config.minRuns))) {
    errors.push("minRuns: minimum is 1 and must be finite");
  }
  if (config.dbPath !== undefined && typeof config.dbPath !== "string") {
    errors.push("dbPath: must be a string");
  }
  if (config.logLevel !== undefined && !["silent", "error", "warn", "info", "debug"].includes(config.logLevel)) {
    errors.push("logLevel: must be silent|error|warn|info|debug");
  }
  return errors;
}

/**
 * Load config from layered sources.
 * Priority (highest wins): CLI > env > config file > defaults.
 */
export function loadConfig(cliOverrides: Partial<SolidusConfig>): ResolvedConfig {
  const config: Record<string, unknown> = {};
  const sources: Record<string, ConfigSource> = {};

  // Layered config: each layer overwrites the previous.
  // Priority (highest wins): CLI > env > config file > defaults.

  // Layer 1: defaults
  for (const [k, v] of Object.entries(DEFAULTS)) {
    config[k] = v;
    sources[k] = "default";
  }

  // Layer 2: config file
  const configPaths = [
    ".solidusrc",
    ".solidusrc.json",
    ".config/solidus/config.json",
  ];
  for (const p of configPaths) {
    const absolutePath = resolve(p);
    const fileConfig = readConfigFile(absolutePath);
    if (fileConfig !== null) {
      for (const [k, v] of Object.entries(fileConfig)) {
        if (v !== undefined) {
          config[k] = v;
          sources[k] = "file";
        }
      }
      break;
    }
  }

  // Layer 3: environment
  const envConfig = readEnv();
  for (const [k, v] of Object.entries(envConfig)) {
    if (v !== undefined) {
      config[k] = v;
      sources[k] = "env";
    }
  }

  // Layer 4: CLI overrides
  for (const [k, v] of Object.entries(cliOverrides)) {
    if (v !== undefined) {
      config[k] = v;
      sources[k] = "cli";
    }
  }

  const errors = validateConfig(config as Partial<SolidusConfig>);
  if (errors.length > 0) {
    throw new ConfigError(`Config validation failed:\n  ${errors.join("\n  ")}`);
  }

  return { ...(config as unknown as SolidusConfig), _sources: sources };
}
