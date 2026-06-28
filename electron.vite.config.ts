import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'

/**
 * Inject CSP meta tag only for production builds.
 * In dev mode the tag is omitted so Vite's HMR WebSocket and inline
 * scripts are not blocked.
 */
function cspPlugin(): Plugin {
  const CSP_TAG =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; script-src \'self\'" />'
  return {
    name: 'csp',
    transformIndexHtml: {
      order: 'post' as const,
      handler(html, ctx) {
        // During dev keep it out so HMR works; during builds inject it.
        if (ctx.server) return html
        return html.replace('</head>', `  ${CSP_TAG}\n  </head>`)
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue(), cspPlugin()]
  }
})
