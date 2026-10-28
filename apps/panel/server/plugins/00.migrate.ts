import { resolve } from 'node:path'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

/**
 * Applies pending SQL migrations on startup so a fresh install only needs a
 * database URL. Fails hard: the panel must not run on an outdated schema.
 */
export default defineNitroPlugin(() => {
  const { migrationsDir } = useRuntimeConfig()
  const folder = resolve(process.cwd(), migrationsDir)
  registerStartupTask(
    migrate(useDb(), { migrationsFolder: folder }).then(() => {
      console.info(`[db] migrations applied from ${folder}`)
    }),
  )
})
