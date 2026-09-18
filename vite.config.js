import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        // three is only the backdrop and solana only the chain calls: splitting them
        // keeps the first paint small and lets each cache independently.
        manualChunks: {
          three: ['three'],
          solana: ['@solana/kit', '@solana-program/memo', '@solana-program/system', '@solana-program/compute-budget', '@wallet-standard/app'],
        },
      },
    },
  },
  server: { port: 5173 },
});
