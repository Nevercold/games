import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

/** Deletes a group; its servers fall back to "ungrouped" (FK set null). */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const { id } = await getValidatedRouterParams(event, params.parse)
  const deleted = await useDb()
    .delete(schema.serverGroups)
    .where(and(eq(schema.serverGroups.id, id), eq(schema.serverGroups.userId, actor.id)))
    .returning({ id: schema.serverGroups.id })
  if (!deleted.length) throw createError({ statusCode: 404, statusMessage: 'group not found' })
  setResponseStatus(event, 204)
  return null
})
