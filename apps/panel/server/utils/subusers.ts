import { isServerPermission, type ServerPermission } from '#shared/permissions'
import { z } from 'zod'

export const subuserPermissionsSchema = z
  .array(z.string())
  .max(100)
  .transform((list) => [...new Set(list)])
  .refine((list) => list.every(isServerPermission), { message: 'unknown permission' })

/** Subusers may only hand out permissions they hold themselves. */
export function assertGrantable(granter: Set<ServerPermission>, requested: string[]) {
  const missing = requested.filter((p) => !granter.has(p as ServerPermission))
  if (missing.length) {
    throw createError({ statusCode: 403, statusMessage: `cannot grant permissions you lack: ${missing.join(', ')}` })
  }
}
