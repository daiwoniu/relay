import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRelayConfig } from '../scripts/lib/relay-config.mjs'
import { configurePublicProxy, createPublicAccessPlugin, getAllowedHosts } from './vite-public-access.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const relayVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version

export function createFrontendStatusPlugin(startedAt = Date.now()): Plugin {
  return {
    name: 'relay-frontend-status',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' || request.url?.split('?')[0] !== '/__relay/frontend-status') {
          next()
          return
        }
        response.statusCode = 200
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        response.end(JSON.stringify({ startedAt, mode: 'development', buildId: null, buildLabel: null }))
      })
    },
  }
}

function loadOrCreateAccessToken(configuredToken: string) {
  if (configuredToken) return configuredToken
  const tokenPath = path.resolve(__dirname, '..', 'server', 'data', 'access-token')
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
  try {
    fs.writeFileSync(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error
  }
  return fs.readFileSync(tokenPath, 'utf8').trim()
}

function splitVendorChunk(id: string) {
  const normalized = id.replace(/\\/g, '/')
  if (!normalized.includes('/node_modules/')) return undefined
  if (['highlight.js', 'react-markdown', 'rehype-', 'remark-', 'unified', 'micromark', 'mdast-', 'hast-', 'property-information'].some((name) => normalized.includes(`/node_modules/${name}`))) {
    return 'markdown-vendor'
  }
  if (/\/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler|zustand)\//.test(normalized)) {
    return 'react-vendor'
  }
  return undefined
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, '..', '')
  const relayConfig = loadRelayConfig(path.resolve(__dirname, '..', 'config', 'relay.conf'))
  const serve = command === 'serve'
  const accessToken = serve ? loadOrCreateAccessToken(process.env.RELAY_ACCESS_TOKEN || env.RELAY_ACCESS_TOKEN || '') : ''
  const proxyHeaders = accessToken ? { 'X-Relay-Token': accessToken } : undefined
  const relayHttpTarget = relayConfig.backend.origin
  const relayWsTarget = relayHttpTarget.replace(/^http/, 'ws')

  return {
    envDir: '..',
    define: {
      __RELAY_VERSION__: JSON.stringify(relayVersion),
    },
    plugins: [createPublicAccessPlugin(relayConfig), createFrontendStatusPlugin(), react(), tailwindcss()],
    build: {
      manifest: true,
      target: 'es2022',
      minify: 'terser',
      terserOptions: {
        compress: { passes: 3 },
        format: { comments: false },
      },
      chunkSizeWarningLimit: 500,
      rollupOptions: {
        output: {
          manualChunks: splitVendorChunk,
        },
      },
    },
    server: {
      host: process.env.RELAY_DEV_LAN === '1' ? '0.0.0.0' : relayConfig.frontend.listenHost,
      port: relayConfig.frontend.port,
      allowedHosts: getAllowedHosts(relayConfig),
      proxy: {
        '/api': {
          target: relayHttpTarget,
          headers: proxyHeaders,
          configure: (proxy) => configurePublicProxy(proxy, relayConfig),
        },
        '/ws': {
          target: relayWsTarget,
          ws: true,
          headers: proxyHeaders,
          configure: (proxy) => configurePublicProxy(proxy, relayConfig),
        },
      },
    },
  }
})
