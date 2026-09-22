import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/frontend/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/frontend/setup.ts'],
    clearMocks: true,
  },
})
