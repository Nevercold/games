import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const body = z.intersection(
  z.object({ name: z.string().trim().min(1).max(64), isDefault: z.boolean().default(false) }),
  targetInputSchema,
)

/** Updates a target. Empty secret fields keep the stored credentials. */
export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.backups.write')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const input = await readValidatedBody(event, body.parse)
  const db = useDb()
  const existing = await db.query.backupTargets.findFirst({ where: eq(schema.backupTargets.id, id) })
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'target not found' })
  if (existing.type !== input.type) throw createError({ statusCode: 422, statusMessage: 'Der Typ eines Ziels kann nicht geändert werden' })

  let previous: Record<string, unknown> | null = null
  try {
    previous = decryptTargetConfig(existing)
  } catch {
    // unreadable (app key changed): the admin has to re-enter all secrets
  }
  const config = mergeSecrets(input.type, input.config, previous)
  const reason = incompleteReason(input.type, config)
  if (reason) throw createError({ statusCode: 422, statusMessage: reason })

  try {
    await db.transaction(async (tx) => {
      if (input.isDefault) await tx.update(schema.backupTargets).set({ isDefault: false }).where(eq(schema.backupTargets.isDefault, true))
      await tx
        .update(schema.backupTargets)
        .set({ name: input.name, config: encryptTargetConfig(config), ...(input.isDefault ? { isDefault: true } : {}) })
        .where(eq(schema.backupTargets.id, id))
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw createError({ statusCode: 409, statusMessage: 'Name bereits vergeben' })
    throw err
  }
  return { ok: true }
})
