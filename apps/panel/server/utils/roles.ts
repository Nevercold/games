import { isAdminPermission } from '#shared/permissions'
import { z } from 'zod'

export const roleBodySchema = z.object({
  name: z.string().trim().min(1).max(48),
  description: z.string().trim().max(500).nullable().default(null),
  permissions: z
    .array(z.string())
    .max(100)
    .transform((l) => [...new Set(l)])
    .refine((l) => l.every(isAdminPermission), { message: 'unknown permission' }),
})

/** Nobody may create or edit a role with rights they do not hold. */
export function assertPermissionsHeld(actor: Actor, permissions: string[]) {
  const missing = permissions.filter((p) => !actor.adminPermissions.has(p as never))
  if (missing.length) {
    throw createError({ statusCode: 403, statusMessage: `you lack: ${missing.join(', ')}` })
  }
}

export function isUniqueViolation(err: unknown) {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.code === '23505' || e?.cause?.code === '23505'
}
