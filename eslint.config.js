import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'resources/**', 'build-scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
