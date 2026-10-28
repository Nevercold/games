import { convertEgg } from '@panel/shared'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  /** Raw egg JSON (as text, so large eggs survive unchanged). */
  egg: z.string().min(2).max(2_000_000),
  /** Replace an existing template with the same slug. */
  overwrite: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.templates.write')
  const body = await readValidatedBody(event, bodySchema.parse)

  let raw: unknown
  try {
    raw = JSON.parse(body.egg)
  } catch {
    throw createError({ statusCode: 422, statusMessage: 'egg is not valid JSON' })
  }

  let result
  try {
    result = convertEgg(raw)
  } catch (err) {
    throw createError({ statusCode: 422, statusMessage: (err as Error).message })
  }
  const { template, warnings } = result
  const db = useDb()

  const existing = await db.query.templates.findFirst({ where: eq(schema.templates.slug, template.id), columns: { id: true } })
  if (existing && !body.overwrite) {
    throw createError({ statusCode: 409, statusMessage: `template "${template.id}" already exists` })
  }

  const values = { slug: template.id, name: template.name, version: template.version, definition: template }
  const [row] = existing
    ? await db.update(schema.templates).set(values).where(eq(schema.templates.id, existing.id)).returning({ id: schema.templates.id })
    : await db.insert(schema.templates).values(values).returning({ id: schema.templates.id })

  setResponseStatus(event, existing ? 200 : 201)
  return { id: row!.id, slug: template.id, name: template.name, warnings, replaced: !!existing }
})
