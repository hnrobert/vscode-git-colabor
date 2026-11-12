import type { JsonResult, Warning } from '../core/types.js';
import { toErrorPayload } from '../core/errors.js';

export function ok(data: unknown, warnings?: Warning[]): JsonResult {
  return warnings && warnings.length > 0 ? { ok: true, data, warnings } : { ok: true, data };
}

export function failFromError(e: unknown): JsonResult {
  return { ok: false, error: toErrorPayload(e), data: null };
}

export type EmitOpts = { json: boolean; human?: (r: JsonResult) => string };

/** Print the result (JSON to stdout, or human text) and exit with the proper code. */
export function emit(result: JsonResult, opts: EmitOpts): never {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (opts.human) {
    const txt = opts.human(result);
    if (txt) {
      const stream = result.ok ? process.stdout : process.stderr;
      stream.write(txt.endsWith('\n') ? txt : `${txt}\n`);
    }
  }
  process.exit(result.ok ? 0 : result.error.exitCode);
}
