import type { ErrorPayload } from './types.js';

export const EXIT_CODES = {
  OK: 0,
  RUNTIME: 1,
  USAGE: 2,
  NOT_A_REPO: 3,
  SECRET_UNAVAILABLE: 4,
  NOT_FOUND: 5,
  CONFLICT_BLOCKED: 6,
} as const;

export type ErrorInit = {
  code: string;
  message: string;
  exitCode?: number;
  hints?: string[];
};

/** Application error carrying a stable code + exit code. */
export class AppError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hints?: string[];
  constructor(init: ErrorInit) {
    super(init.message);
    this.name = 'AppError';
    this.code = init.code;
    this.exitCode = init.exitCode ?? EXIT_CODES.RUNTIME;
    this.hints = init.hints;
  }
  toPayload(): ErrorPayload {
    return { code: this.code, message: this.message, hints: this.hints, exitCode: this.exitCode };
  }
}

export const Errors = {
  notARepo: (cwd?: string) =>
    new AppError({
      code: 'NOT_A_REPO',
      message: cwd ? `not a git repository: ${cwd}` : 'not a git repository',
      exitCode: EXIT_CODES.NOT_A_REPO,
    }),
  authorNotFound: (key: string) =>
    new AppError({
      code: 'AUTHOR_NOT_FOUND',
      message: `Author with initials "${key}" not found in identities`,
      exitCode: EXIT_CODES.NOT_FOUND,
      hints: [`Add it with: git colabor coauthor add ${key} "Full Name" email@example.com`],
    }),
  duplicateKey: (key: string) =>
    new AppError({
      code: 'DUPLICATE_KEY',
      message: `Key "${key}" already exists`,
      exitCode: EXIT_CODES.NOT_FOUND,
      hints: [],
    }),
  invalidEmail: (email: string) =>
    new AppError({ code: 'INVALID_EMAIL', message: `Invalid email: ${email}`, exitCode: EXIT_CODES.USAGE }),
  usage: (message: string, hints?: string[]) =>
    new AppError({ code: 'USAGE', message, exitCode: EXIT_CODES.USAGE, hints }),
  secretUnavailable: (message: string, hints?: string[]) =>
    new AppError({ code: 'SECRET_UNAVAILABLE', message, exitCode: EXIT_CODES.SECRET_UNAVAILABLE, hints }),
};

export function toErrorPayload(e: unknown): ErrorPayload {
  if (e instanceof AppError) return e.toPayload();
  const message = e instanceof Error ? e.message : String(e);
  return { code: 'INTERNAL', message, exitCode: EXIT_CODES.RUNTIME };
}
