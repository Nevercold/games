export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: true },
  devServer: { port: 3100 },

  modules: ['@nuxt/ui', 'nuxt-auth-utils'],

  css: ['~/assets/css/main.css'],

  typescript: {
    strict: true,
    typeCheck: false,
  },

  runtimeConfig: {
    databaseUrl: 'postgres://panel:panel@localhost:5433/panel',
    appKey: '',
    /** Honour X-Forwarded-For (only behind a trusted reverse proxy). */
    trustProxy: false,
    migrationsDir: 'server/db/migrations',
    pluginsDir: '../../data/plugins',
    tunnel: {
      heartbeatIntervalS: 15,
    },
  },

  vite: {
    optimizeDeps: { include: ['zod'] },
  },

  nitro: {
    experimental: {
      websocket: true,
      tasks: true,
    },
  },
})
