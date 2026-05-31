import { promises as fs } from "fs";
import path from "path";

/**
 * Tiny structured logger. Writes to the dev-server console AND appends to
 * data/jobnow.log so a run can be analyzed after the fact (`GET /api/logs`).
 */

const LOG_FILE = path.join(process.cwd(), "data", "jobnow.log");
type Level = "debug" | "info" | "warn" | "error";

// On Vercel the filesystem is read-only — log to console only there.
const FILE_LOGGING = !process.env.VERCEL;

function appendFile(line: string) {
  if (!FILE_LOGGING) return;
  fs.mkdir(path.dirname(LOG_FILE), { recursive: true })
    .then(() => fs.appendFile(LOG_FILE, line + "\n"))
    .catch(() => {});
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(scope: string): Logger;
  /** Returns a stop() that logs elapsed ms when called. */
  timer(label: string): () => number;
}

function line(level: Level, tag: string, msg: string, data?: unknown): string {
  const extra = data !== undefined ? " " + safeJson(data) : "";
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}${extra}`;
}

function safeJson(d: unknown): string {
  try {
    return JSON.stringify(d);
  } catch {
    return String(d);
  }
}

export function createLogger(scope = "jobnow", runId?: string): Logger {
  const tag = runId ? `${scope}#${runId}` : scope;
  const emit = (level: Level, msg: string, data?: unknown) => {
    const text = line(level, tag, msg, data);
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(text);
    appendFile(text);
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
    child: (s) => createLogger(`${scope}:${s}`, runId),
    timer: (label) => {
      const start = Date.now();
      emit("debug", `▶ ${label}`);
      return () => {
        const ms = Date.now() - start;
        emit("info", `✓ ${label}`, { ms });
        return ms;
      };
    },
  };
}

/** Short, sortable-ish run id without Math.random dependency on crypto. */
export function newRunId(): string {
  return (
    Date.now().toString(36).slice(-5) +
    Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")
  );
}

export async function readLogTail(maxLines = 300): Promise<string> {
  try {
    const all = await fs.readFile(LOG_FILE, "utf8");
    return all.split("\n").slice(-maxLines).join("\n");
  } catch {
    return "(no logs yet)";
  }
}

export async function clearLog(): Promise<void> {
  await fs.writeFile(LOG_FILE, "").catch(() => {});
}
