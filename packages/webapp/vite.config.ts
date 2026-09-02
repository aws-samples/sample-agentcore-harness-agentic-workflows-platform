import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The package ships CJS (fine for Lambda/CDK consumers); the SPA
      // consumes the TS source directly so rollup sees real ESM exports.
      '@agentic-platform/plan-schema': fileURLToPath(
        new URL('../plan-schema/src/index.ts', import.meta.url),
      ),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
