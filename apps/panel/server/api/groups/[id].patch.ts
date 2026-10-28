import { and, eq } from 'drizzle-orm'
import { ORG_COLORS } from '#shared/permissions'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const bodySchema = z.object({
  name: z.string().trim().min(1).max(48).optional(),
  color: z.enum(ORG_COLORS).optional(),
  collapsed: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const { id } = await getValidatedRouterParams(event, params.parse)
  const body = await readValidatedBody(event, bodySchema.parse)
  const updated = await useDb()
    .update(schema.serverGroups)
    .set(body)
    .where(and(eq(schema.serverGroups.id, id), eq(schema.serverGroups.userId, actor.id)))
    .returning({ id: schema.serverGroups.id })
  if (!updated.length) throw createError({ statusCode: 404, statusMessage: 'group not found' })
  return { ok: true }
})
