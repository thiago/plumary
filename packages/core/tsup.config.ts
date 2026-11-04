import { defineConfig } from 'tsup'

// ESM for JS hosts; IIFE single-file for JavaScriptCore / QuickJS embedding.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'iife'],
  globalName: 'Plumary',
  dts: true,
  clean: true,
  platform: 'neutral',
  target: 'es2022',
})
