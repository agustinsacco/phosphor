import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'

// Static site, served by Node from the combined apps/control/Dockerfile image.
export default defineConfig({
  site: 'https://phosphor.saccolabs.com',
  output: 'static',
  trailingSlash: 'always',
  build: {
    // Hashed asset names under /_astro are immutable; the control server caches them for a year.
    assets: '_astro',
  },
  vite: {
    plugins: [tailwindcss()],
  },
})
