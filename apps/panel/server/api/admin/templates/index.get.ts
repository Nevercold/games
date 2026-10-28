import { templateSchema } from '@panel/shared'
import { asc, count, eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.templates.read')
  const rows = await useDb()
    .select({
      id: schema.templates.id,
      slug: schema.templates.slug,
      name: schema.templates.name,
      version: schema.templates.version,
      definition: schema.templates.definition,
      createdAt: schema.templates.createdAt,
      serverCount: count(schema.servers.id),
    })
    .from(schema.templates)
    .leftJoin(schema.servers, eq(schema.servers.templateId, schema.templates.id))
    .groupBy(schema.templates.id)
    .orderBy(asc(schema.templates.name))

  return rows.flatMap(({ definition, ...row }) => {
    const parsed = templateSchema.safeParse(definition)
    if (!parsed.success) return []
    const t = parsed.data
    return [{
      ...row,
      description: t.description ?? null,
      author: t.author ?? null,
      source: t.source ?? null,
      images: t.images,
      startup: t.startup?.command ?? '',
      variables: t.variables,
      hasInstall: !!t.hooks.install,
      resources: t.resources,
    }]
  })
})
