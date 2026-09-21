import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Talks straight to Qdrant — no backend. Qdrant reflects the request Origin in
// `access-control-allow-origin`, so a browser fetch from here is allowed
// without a proxy. It reflects *any* Origin, which is why this is a localhost
// tool: see the README's security section before pointing it at a host other
// people can reach.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 4173 },
  test: {
    // The test suite covers pure payload/formatting logic, so it needs no DOM.
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
