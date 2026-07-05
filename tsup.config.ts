import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { extension: 'src/extension.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node18',
  outDir: 'dist',
  external: ['vscode'],
  splitting: false,
  sourcemap: false,
  treeshake: true,
  clean: true,
});
