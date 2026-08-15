import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
  },
})
