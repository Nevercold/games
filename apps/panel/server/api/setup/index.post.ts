import { sql } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  email: z.email().max(255),
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(10).max(1024),
})

/**
 * Creates the first admin account. Only works while the users table is empty;
 * an advisory lock prevents two concurrent setup requests from both winning.
 */
export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, bodySchema.parse)
  assertRateLimit(`setup:${clientIp(event)}`, 5)
  const passwordHash = await hashPassword(body.password)

  const user = await useDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(4242001)`)
    const existing = await tx.select({ id: schema.users.id }).from(schema.users).limit(1)
    if (existing.length > 0) {
      throw createError({ statusCode: 409, statusMessage: 'setup already completed' })
    }
    const [created] = await tx
      .insert(schema.users)
      .values({ email: body.email, username: body.username, passwordHash, isAdmin: true })
      .returning()
    return created!
  })

  await setUserSession(event, { user: toSessionUser(user), loggedInAt: Date.now() })
  await usePanelHooks().callHook('user.created', { userId: user.id })
  return { ok: true }
})
