import { defineConfig } from 'vitest/config';

// CDK synth tests stage Lambda assets (provider framework, log retention),
// which can exceed vitest's 5s default on cold caches. Mirrored in the
// per-package configs for workspace-scoped runs.
export default defineConfig({
  test: { testTimeout: 30_000 },
});
