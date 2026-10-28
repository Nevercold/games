import { count, eq, max } from 'drizzle-orm'
import { ORG_COLORS } from '#shared/permissions'
import { z } from 'zod'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: z.enum(ORG_COLORS).default('neutral'),
})

const MAX_GROUPS = 100

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const body = await readValidatedBody(event, bodySchema.parse)
  const db = useDb()

  const [stats] = await db
    .select({ n: count(), maxOrder: max(schema.serverGroups.sortOrder) })
    .from(schema.serverGroups)
    .where(eq(schema.serverGroups.userId, actor.id))
  if ((stats?.n ?? 0) >= MAX_GROUPS) throw createError({ statusCode: 409, statusMessage: 'too many groups' })

  const [group] = await db
    .insert(schema.serverGroups)
    .values({ userId: actor.id, ...body, sortOrder: (stats?.maxOrder ?? -1) + 1 })
    .returning()
  setResponseStatus(event, 201)
  return group
})
