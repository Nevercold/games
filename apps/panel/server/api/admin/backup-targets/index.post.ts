import { eq } from 'drizzle-orm'
import { z } from 'zod'

const targetBody = z.intersection(
  z.object({ name: z.string().trim().min(1).max(64), isDefault: z.boolean().default(false) }),
  targetInputSchema,
)

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.backups.write')
  const body = await readValidatedBody(event, targetBody.parse)
  const reason = incompleteReason(body.type, body.config)
  if (reason) throw createError({ statusCode: 422, statusMessage: reason })

  const db = useDb()
  try {
    const target = await db.transaction(async (tx) => {
      const first = !(await tx.query.backupTargets.findFirst({ columns: { id: true } }))
      const isDefault = body.isDefault || first
      if (isDefault) await tx.update(schema.backupTargets).set({ isDefault: false }).where(eq(schema.backupTargets.isDefault, true))
      const [row] = await tx
        .insert(schema.backupTargets)
        .values({ name: body.name, type: body.type, config: encryptTargetConfig(body.config), isDefault })
        .returning({ id: schema.backupTargets.id })
      return row!
    })
    setResponseStatus(event, 201)
    return target
  } catch (err) {
    if (isUniqueViolation(err)) throw createError({ statusCode: 409, statusMessage: 'Name bereits vergeben' })
    throw err
  }
})
