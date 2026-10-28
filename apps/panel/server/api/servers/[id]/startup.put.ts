import { templateSchema, validateVariables } from '@panel/shared'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const bodySchema = z.object({
  variables: z.record(z.string(), z.string().max(4096)).default({}),
  image: z.string().trim().min(1).max(255).optional(),
})

/**
 * Updates startup variables (and optionally the image variant). Regular users
 * may only change variables the template marks as user_editable; admins with
 * admin.servers.write may change all of them. Takes effect on the next start.
 */
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const body = await readValidatedBody(event, bodySchema.parse)
  const { server, actor } = await requireServerPermission(event, id, 'startup.update')
  const adminEdit = actor.adminPermissions.has('admin.servers.write')

  if (!server.templateId) throw createError({ statusCode: 409, statusMessage: 'server has no template' })
  const row = await useDb().query.templates.findFirst({ where: eq(schema.templates.id, server.templateId) })
  if (!row) throw createError({ statusCode: 409, statusMessage: 'template missing' })
  const template = templateSchema.parse(row.definition)

  // Masked secrets come back unchanged; keep the stored value.
  const input = Object.fromEntries(Object.entries(body.variables).filter(([, v]) => v !== SECRET_MASK))
  const result = validateVariables(template.variables, input, { previous: server.variables, onlyUserEditable: !adminEdit })
  if (Object.keys(result.errors).length) {
    throw createError({ statusCode: 422, statusMessage: 'invalid variables', data: { errors: result.errors } })
  }

  let image = server.image
  if (body.image && body.image !== server.image) {
    const allowed = Object.values(template.images)
    if (!allowed.includes(body.image)) throw createError({ statusCode: 422, statusMessage: 'image is not offered by the template' })
    image = body.image
  }

  await useDb().update(schema.servers).set({ variables: result.values, image }).where(eq(schema.servers.id, id))
  return { ok: true, restartRequired: server.status === 'running' || server.status === 'starting' }
})
