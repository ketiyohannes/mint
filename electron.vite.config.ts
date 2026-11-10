import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const shared = resolve(__dirname, 'src/shared')

/**
 * Content-Security-Policy for the renderer. Dev needs inline scripts and the
 * Vite websocket for hot reload; production does not.
 */
function cspPlugin(): Plugin {
  const common = [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://i.ytimg.com",
    "font-src 'self' data:",
    'frame-src mint-sandbox: https://www.youtube-nocookie.com',
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'"
  ]
  return {
    name: 'mint-csp',
    transformIndexHtml(html, ctx) {
      const dev = Boolean(ctx.server)
      // 'wasm-unsafe-eval': pdf.js decodes some image formats with WebAssembly.
      const csp = [
        ...common,
        dev ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'" : "script-src 'self' 'wasm-unsafe-eval'",
        dev ? "connect-src 'self' ws: http://localhost:* blob: data:" : "connect-src 'self' blob: data:"
      ].join('; ')
      return html.replace('%MINT_CSP%', csp)
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      // Sandboxed preloads must be a single CommonJS file.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react(), cspPlugin()],
    worker: { format: 'es' },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
