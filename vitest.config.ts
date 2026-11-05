import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// Tests for the pure parts of the server and web code. No PDI, no network: each test file gets its own
// throwaway data and config folders (tests/setup.ts), and instance calls are mocked.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // node:sqlite is experimental in Node 22: without this every test file prints the same warning.
    execArgv: ['--disable-warning=ExperimentalWarning'],
    // Most of the suite waits on child processes (git, bash scripts, sleeps), not the CPU, so more workers than cores
    // finish sooner: 1.5x took a 4-core machine from 24 s to 17 s. The default is cores - 1, and a percentage is capped at 100.
    maxWorkers: Math.ceil(availableParallelism() * 1.5),
  },
});
