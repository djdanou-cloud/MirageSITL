import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Required for SharedArrayBuffer. Apply these on the production HTTPS server too.
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { headers },
  preview: { headers },
  worker: { format: 'es' },
});
