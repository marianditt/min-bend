import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // GitHub Pages serves this project site under /<repository-name>/.
  // Keep the dev server at the root for convenience, but prefix all
  // built asset URLs with the repo name so the deployed site works.
  base: command === 'build' ? '/min-bend/' : '/',
  plugins: [react()],
  test: { testTimeout: 30000 },
}))
