import { ORG_COLORS } from '#shared/permissions'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const bodySchema = z.object({ color: z.enum(ORG_COLORS).nullable() })

/** Per-user server color (only visible to the user who set it). */
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { color } = await readValidatedBody(event, bodySchema.parse)
  const { actor } = await requireServerPermission(event, id)
  await useDb()
    .insert(schema.userServerPrefs)
    .values({ userId: actor.id, serverId: id, color })
    .onConflictDoUpdate({ target: [schema.userServerPrefs.userId, schema.userServerPrefs.serverId], set: { color } })
  return { ok: true }
})
