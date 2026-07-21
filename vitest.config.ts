import {defineConfig} from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['packages/**/*.test.ts', 'packages/**/*.test.tsx', '.bugs/**/*.test.ts'],
    exclude: ['**/dist/**', '**/node_modules/**', '**/_examples/**'],
    environment: 'node',
    passWithNoTests: true
  }
});
