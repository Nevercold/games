import { eq, or, sql } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  login: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(1024),
})

export default defineEventHandler(async (event) => {
  const { login, password } = await readValidatedBody(event, bodySchema.parse)
  assertRateLimit(`login:${clientIp(event)}`)

  const db = useDb()
  const user = await db.query.users.findFirst({
    where: or(
      eq(sql`lower(${schema.users.email})`, login.toLowerCase()),
      eq(sql`lower(${schema.users.username})`, login.toLowerCase()),
    ),
  })

  // Always run a hash check to keep timing similar for unknown users.
  const valid = user?.passwordHash
    ? await verifyPassword(user.passwordHash, password)
    : (await hashPassword(password), false)

  if (!user || !valid) {
    throw createError({ statusCode: 401, statusMessage: 'invalid credentials' })
  }

  await setUserSession(event, { user: toSessionUser(user), loggedInAt: Date.now() })
  await usePanelHooks().callHook('auth.login', { userId: user.id })
  return { ok: true }
})
