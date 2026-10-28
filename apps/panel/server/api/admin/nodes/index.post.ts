import { z } from 'zod'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(500).optional(),
  publicHost: z.string().trim().min(1).max(255),
  memoryMb: z.number().int().min(0).default(0),
  diskMb: z.number().int().min(0).default(0),
  dockerManagement: z.boolean().default(true),
})

/** Creates a node and returns its token once. The token is never shown again. */
export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.nodes.write')
  const body = await readValidatedBody(event, bodySchema.parse)
  const { secret, hash } = generateNodeSecret()

  const [node] = await useDb()
    .insert(schema.nodes)
    .values({ ...body, tokenHash: hash })
    .returning({ id: schema.nodes.id, name: schema.nodes.name })

  setResponseStatus(event, 201)
  return { ...node!, token: formatNodeToken(node!.id, secret) }
})
