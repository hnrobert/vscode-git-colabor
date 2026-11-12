export type GlobalFlags = {
  json: boolean;
  noColor: boolean;
  help: boolean;
  version: boolean;
  logLevel?: string;
  cwd?: string;
};

/** Extract global flags from argv; everything else (positionals + per-command flags) is returned in order. */
export function parseGlobals(argv: string[]): { flags: GlobalFlags; rest: string[] } {
  const flags: GlobalFlags = { json: false, noColor: false, help: false, version: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok) continue;
    if (tok === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (tok === '-C') {
      flags.cwd = argv[++i];
      continue;
    }
    if (tok.startsWith('-C') && tok.length > 2) {
      flags.cwd = tok.slice(2);
      continue;
    }
    if (tok === '--log-level') {
      flags.logLevel = argv[++i];
      continue;
    }
    if (tok.startsWith('--log-level=')) {
      flags.logLevel = tok.slice('--log-level='.length);
      continue;
    }
    if (tok === '--json') {
      flags.json = true;
      continue;
    }
    if (tok === '--no-color') {
      flags.noColor = true;
      continue;
    }
    if (tok === '-h' || tok === '--help') {
      flags.help = true;
      continue;
    }
    if (tok === '-v' || tok === '--version') {
      flags.version = true;
      continue;
    }
    rest.push(tok);
  }
  return { flags, rest };
}

export type CmdSpec = { valueFlags?: string[]; boolFlags?: string[] };
export type CmdParsed = {
  positionals: string[];
  values: Record<string, string>;
  bools: Set<string>;
};

/** Parse a command's tokens into positionals, value-flags (key→value), and boolean flags. */
export function parseCommandArgs(tokens: string[], spec: CmdSpec = {}): CmdParsed {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const valueFlags = new Set(spec.valueFlags ?? []);
  const boolFlags = new Set(spec.boolFlags ?? []);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (tok.startsWith('--') && tok.includes('=')) {
      const eq = tok.indexOf('=');
      const k = tok.slice(0, eq);
      const v = tok.slice(eq + 1);
      if (valueFlags.has(k)) values[k] = v;
      else bools.add(k);
      continue;
    }
    if (valueFlags.has(tok)) {
      const v = tokens[++i];
      if (v !== undefined) values[tok] = v;
      continue;
    }
    if (boolFlags.has(tok)) {
      bools.add(tok);
      continue;
    }
    if (tok.startsWith('-')) {
      bools.add(tok);
      continue;
    }
    positionals.push(tok);
  }
  return { positionals, values, bools };
}
