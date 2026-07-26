import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('electron/main.ts') }
      }
    },
    resolve: {
      alias: { '@core': resolve('src/core') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('electron/preload.ts') },
        // Electron preload cannot be ESM. Package is "type": "module",
        // so CJS output must use .cjs or Node parses it as ESM.
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/ui'),
    build: {
      rollupOptions: {
        input: { index: resolve('src/ui/index.html') }
      }
    },
    resolve: {
      alias: { '@ui': resolve('src/ui') }
    },
    plugins: [react()]
  }
})
