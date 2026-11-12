import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const VALID: ReadonlySet<string> = new Set(['trace', 'debug', 'info', 'warn', 'error']);
const MAX_BYTES = 2 * 1024 * 1024;

const redactable = new Set<string>();

/** Register a secret value (passphrase / key body / token) so it is scrubbed from logs. */
export function addRedactable(s: string): void {
  if (s && s.length > 0) redactable.add(s);
}

export function redact(input: string): string {
  let out = input;
  for (const r of redactable) out = out.split(r).join('[redacted]');
  return out;
}

function redactFields(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields) return {};
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) o[k] = typeof v === 'string' ? redact(v) : v;
  return o;
}

export function defaultLogFile(): string {
  if (process.env.GIT_COLABOR_LOG_FILE) return process.env.GIT_COLABOR_LOG_FILE;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Logs', 'git-colabor', 'cli.log');
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'git-colabor', 'logs', 'cli.log');
  }
  return join(process.env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'git-colabor', 'cli.log');
}

function levelFromEnv(): LogLevel {
  const v = process.env.GIT_COLABOR_LOG_LEVEL?.toLowerCase();
  return v && VALID.has(v) ? (v as LogLevel) : 'info';
}

export interface Logger {
  readonly level: LogLevel;
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(opts: { level?: LogLevel; file?: string } = {}): Logger {
  const level = opts.level ?? levelFromEnv();
  const file = opts.file ?? defaultLogFile();
  let writing: Promise<void> = Promise.resolve();
  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const rec =
      JSON.stringify({
        ts: new Date().toISOString(),
        level: lvl,
        msg: redact(String(msg)),
        ...redactFields(fields),
      }) + '\n';
    writing = writing.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        try {
          const st = await stat(file);
          if (st.size > MAX_BYTES) await rename(file, `${file}.1`);
        } catch {
          // file may not exist yet — fine
        }
        await appendFile(file, rec, 'utf8');
      } catch {
        // best-effort; never throw from the logger
      }
    });
  };
  return {
    level,
    trace: (m, f) => write('trace', m, f),
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}
