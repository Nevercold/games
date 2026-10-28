import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const body = z.object({
  name: z.string().trim().max(100).optional(),
  /** Gitignore-style patterns, one per line. */
  ignore: z.string().max(8000).optional(),
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const input = await readValidatedBody(event, body.parse)
  const { server, actor } = await requireServerPermission(event, id, 'backup.create')
  return createServerBackup(server, { name: input.name, ignore: input.ignore, createdById: actor.id })
})
