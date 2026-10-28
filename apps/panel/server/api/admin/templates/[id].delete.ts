import { count, eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.templates.write')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const db = useDb()
  const [row] = await db.select({ n: count() }).from(schema.servers).where(eq(schema.servers.templateId, id))
  if ((row?.n ?? 0) > 0) throw createError({ statusCode: 409, statusMessage: 'template is used by servers' })
  const deleted = await db.delete(schema.templates).where(eq(schema.templates.id, id)).returning({ id: schema.templates.id })
  if (!deleted.length) throw createError({ statusCode: 404, statusMessage: 'template not found' })
  setResponseStatus(event, 204)
  return null
})
