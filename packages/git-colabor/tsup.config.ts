import { defineConfig } from 'tsup';

export default defineConfig({
  // askpass is the SSH_ASKPASS helper invoked by ssh-add (bundled to dist/askpass.cjs).
  entry: { cli: 'src/cli/index.ts', askpass: 'src/askpass/index.ts', index: 'src/index.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  splitting: false,
  sourcemap: false,
  treeshake: true,
  clean: true,
  // bundle everything into a single file (zero runtime deps)
  noExternal: [/.*/],
});
