import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { avatarkitVitePlugin } from '@spatius/avatarkit/vite'

// avatarkitVitePlugin wires up the SDK's WASM: it copies the .wasm out of
// node_modules/@spatius/avatarkit into the build output and sets the correct MIME in dev.
// Without it the SDK's WASM fetch 404s at runtime.
export default defineConfig({
  plugins: [react(), avatarkitVitePlugin()],
  // The SDK's WASM glue locates its .wasm via import.meta.url; pre-bundling would move the
  // glue into .vite/deps WITHOUT the .wasm and break the fetch. Exclude it.
  optimizeDeps: { exclude: ['@spatius/avatarkit'] },
  assetsInclude: ['**/*.wasm'],
  server: { port: 5190 },
})
