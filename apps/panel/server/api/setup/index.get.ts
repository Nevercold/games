import { count } from 'drizzle-orm'

/** True while no user exists yet: the UI then shows the first-run setup. */
export default defineEventHandler(async () => {
  const [row] = await useDb().select({ n: count() }).from(schema.users)
  return { needsSetup: (row?.n ?? 0) === 0 }
})
