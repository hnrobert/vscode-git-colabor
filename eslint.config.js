import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Pin tsconfigRootDir to this package dir so the TS parser doesn't fall back to
// process.cwd() (which is the workspace root in the IDE → ambiguous multi-tsconfig).
const root = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  // The CLI submodule has its own eslint config; don't lint it from here.
  { ignores: ['dist/**', 'node_modules/**', 'resources/**', 'build-scripts/**', 'git-colabor/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: root },
    },
  },
);
