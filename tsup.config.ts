import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      testing: 'src/testing.ts',
      contract: 'src/contract.ts',
      ui: 'src/ui.ts',
      'ui-testing': 'src/ui-testing.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    // the command line: one CommonJS file with a shebang (the init template path is resolved from its __dirname)
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    dts: false,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
