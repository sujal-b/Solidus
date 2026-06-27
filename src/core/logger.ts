import type { LogLevel } from "./types.js";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const LEVEL_COLORS: Record<string, string> = {
  error: "\x1b[31m", // red
  warn: "\x1b[33m",  // yellow
  info: "\x1b[36m",  // cyan
  debug: "\x1b[90m", // grey
};

export class Logger {
  private level: number;
  private prefix: string;

  constructor(level: LogLevel = "info", prefix = "solidus") {
    this.level = LEVEL_PRIORITY[level] ?? 3;
    this.prefix = prefix;
  }

  private log(level: string, priority: number, msg: string, ...args: unknown[]): void {
    if (priority > this.level) return;
    const color = LEVEL_COLORS[level] ?? "";
    const reset = color ? "\x1b[0m" : "";
    const ts = new Date().toISOString().slice(11, 23);
    if (args.length > 0) {
      const extra = args.map(a => typeof a === "object" ? safeStringify(a) : String(a)).join(" ");
      console.error(`${color}${ts} [${level.toUpperCase()}] ${this.prefix}: ${msg}${reset}`, extra);
    } else {
      console.error(`${color}${ts} [${level.toUpperCase()}] ${this.prefix}: ${msg}${reset}`);
    }
  }

  error(msg: string, ...args: unknown[]): void { this.log("error", 1, msg, ...args); }
  warn(msg: string, ...args: unknown[]): void { this.log("warn", 2, msg, ...args); }
  info(msg: string, ...args: unknown[]): void { this.log("info", 3, msg, ...args); }
  debug(msg: string, ...args: unknown[]): void { this.log("debug", 4, msg, ...args); }

  child(prefix: string): Logger {
    const l = new Logger("silent", `${this.prefix}:${prefix}`);
    l.level = this.level;
    return l;
  }
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, (_k, v) => {
      if (v instanceof Error) return { message: v.message, code: (v as any).code, stack: undefined };
      return v;
    });
  } catch {
    return String(obj);
  }
}
