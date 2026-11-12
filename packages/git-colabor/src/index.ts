/**
 * Programmatic entry for the git-colabor core library (consumed by the VS Code extension
 * build pipeline and by direct require()). The CLI is bundled separately as dist/cli.cjs.
 */
export * from './core/authors/types.js';
export * from './core/message/formatter.js';
export * from './core/message/template.js';
export * from './core/coauthors/state.js';
export * from './core/git/exec.js';
export * from './core/git/config.js';
export * from './core/git/rev.js';
export * from './core/git/shortlog.js';
export * from './core/git/committers.js';
export * from './core/logging/logger.js';
export * from './core/logging/audit.js';
export * from './core/paths.js';
export * from './core/io.js';
export * from './core/repo/state.js';
export * from './core/repo/coordination.js';
export * from './core/repo/status.js';
export * from './core/identity/map.js';
export * from './core/identity/keys.js';
export * from './core/identity/agent.js';
export * from './core/identity/apply.js';
export * from './core/identity/configClear.js';
export * from './core/identity/sign.js';
export * from './core/identity/logout.js';
export * from './core/secrets/askpass-protocol.js';
export * from './core/secrets/bridge.js';
export * from './core/types.js';
export * from './core/errors.js';
