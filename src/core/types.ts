/** Single test result from one run */
export interface TestResult {
  /** Fully qualified test name (e.g. "App > renders button") */
  name: string;
  /** Source file path (relative to project root) */
  file: string;
  /** Pass / fail / skip */
  status: "pass" | "fail" | "skip";
  /** Execution time in ms */
  durationMs: number;
  /** Error message if failed */
  error?: string;
}

/** Metadata for one test run (a CI pipeline or local `npm test`) */
export interface TestRun {
  /** Unique run id (auto-generated if omitted) */
  id: string;
  /** ISO timestamp */
  timestamp: string;
  /** Git commit SHA if available */
  commit?: string;
  /** Branch name if available */
  branch?: string;
  /** CI run ID if applicable */
  ciRunId?: string;
  /** All results in this run */
  results: TestResult[];
}

/** Flake classification for a single test */
export type FlakeClassification =
  | "flaky"
  | "stable_pass"
  | "stable_fail"
  | "insufficient_data";

export interface FlakeReport {
  name: string;
  file: string;
  totalRuns: number;
  passCount: number;
  failCount: number;
  passRate: number;
  classification: FlakeClassification;
  lastStatus: "pass" | "fail" | "skip";
  quarantined: boolean;
}

/** Output of a full analysis run */
export interface AnalysisReport {
  runId: string;
  total: number;
  stable: number;
  flaky: number;
  broken: number;
  quarantined: number;
  insufficientData: number;
  flakes: FlakeReport[];
}

export interface SolidusConfig {
  flakyThresholdLow: number;
  flakyThresholdHigh: number;
  windowSize: number;
  minRuns: number;
  dbPath: string;
  autoQuarantine: boolean;
  /** Log level: silent | error | warn | info | debug */
  logLevel: LogLevel;
}

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

/** A single quarantined test entry */
export interface QuarantineEntry {
  name: string;
  file: string;
  reason: string;
  quarantinedAt: string;
  flakeCount: number;
}

export interface QuarantineStore {
  /** Load quarantine entries. Returns empty array on any error. */
  load(): QuarantineEntry[];
  /** Save quarantine entry (dedup by file::name). Returns true if added. */
  add(entry: QuarantineEntry): boolean;
  /** Remove a quarantine entry by file::name. Returns true if removed. */
  remove(file: string, name: string): boolean;
  /** Check if a test is quarantined */
  isQuarantined(file: string, name: string): boolean;
  /** Generate Jest/Vitest testPathIgnorePatterns snippet */
  toJestPattern(): string;
  /** Clear all quarantine entries */
  clear(): void;
}

export const DEFAULTS: SolidusConfig = {
  flakyThresholdLow: 0.05,
  flakyThresholdHigh: 0.95,
  windowSize: 10,
  minRuns: 3,
  dbPath: ".solidus/history.db",
  autoQuarantine: false,
  logLevel: "info",
};

/**
 * Validate a TestRun object.
 * Returns array of error messages. Empty = valid.
 */
export function validateTestRun(input: unknown): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return ["input must be a JSON object"];

  const obj = input as Record<string, unknown>;

  if (typeof obj.id !== "string" || obj.id.length === 0) {
    errors.push("id: missing or empty string");
  }
  if (typeof obj.timestamp !== "string" || isNaN(Date.parse(obj.timestamp))) {
    errors.push("timestamp: invalid ISO date string");
  }
  if (!Array.isArray(obj.results)) {
    errors.push("results: must be an array");
    return errors; // can't validate further
  }

  for (let i = 0; i < obj.results.length; i++) {
    const r = obj.results[i] as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object") {
      errors.push(`results[${i}]: not an object`);
      continue;
    }
    if (typeof r.name !== "string" || (r.name as string).length === 0) {
      errors.push(`results[${i}].name: missing or empty`);
    }
    if (typeof r.file !== "string" || (r.file as string).length === 0) {
      errors.push(`results[${i}].file: missing or empty`);
    }
    if (typeof r.status !== "string" || !["pass", "fail", "skip"].includes(r.status as string)) {
      errors.push(`results[${i}].status: must be "pass", "fail", or "skip"`);
    }
    if (typeof r.durationMs !== "number" || r.durationMs < 0 || !Number.isFinite(r.durationMs)) {
      errors.push(`results[${i}].durationMs: must be a non-negative number`);
    }
    if (r.error !== undefined && typeof r.error !== "string") {
      errors.push(`results[${i}].error: must be a string if present`);
    }
  }

  return errors;
}
