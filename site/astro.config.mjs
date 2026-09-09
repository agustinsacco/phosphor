import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'

// Static site, served by nginx from the image built in ./Dockerfile.
export default defineConfig({
  site: 'https://phosphor.saccolabs.com',
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    // Hashed asset names under /_astro are immutable; nginx caches them forever.
    assets: '_astro',
  },
  vite: {
    plugins: [tailwindcss()],
  },
})
