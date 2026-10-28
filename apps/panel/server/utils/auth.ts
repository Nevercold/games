import type { H3Event } from 'h3'

export function toSessionUser(u: typeof schema.users.$inferSelect) {
  return { id: u.id, email: u.email, username: u.username, isAdmin: u.isAdmin }
}

/** Client IP. X-Forwarded-For is only honoured when NUXT_TRUST_PROXY=true. */
export function clientIp(event: H3Event) {
  return getRequestIP(event, { xForwardedFor: useRuntimeConfig().trustProxy === true }) ?? 'unknown'
}

// lean-ctx: in-memory limiter, upgrade to a shared store when the panel runs multi-instance
const attempts = new Map<string, { count: number; resetAt: number }>()

/** Non-throwing variant: records a hit and reports whether the limit is exceeded. */
export function rateLimited(key: string, max = 10, windowMs = 60_000): boolean {
  try {
    assertRateLimit(key, max, windowMs)
    return false
  } catch {
    return true
  }
}

/** Simple fixed-window limiter for auth endpoints. */
export function assertRateLimit(key: string, max = 10, windowMs = 60_000) {
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs })
    return
  }
  entry.count++
  if (entry.count > max) {
    throw createError({ statusCode: 429, statusMessage: 'too many attempts, try again later' })
  }
}
