import { templateSchema, validateVariables } from '@panel/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(500).optional(),
  ownerId: z.uuid(),
  nodeId: z.uuid(),
  allocationId: z.uuid(),
  templateId: z.uuid().nullable().default(null),
  /** Docker image; with a template it must be one of the template's images. */
  image: z.string().trim().min(1).max(255),
  /** Startup override; defaults to the template's startup command. */
  startup: z.string().trim().max(2000).optional(),
  variables: z.record(z.string(), z.string().max(4096)).default({}),
  memoryMb: z.number().int().min(64),
  diskMb: z.number().int().min(128),
  cpuPercent: z.number().int().min(0).max(10_000),
  /** Run the template's install script right away (needs the node online). */
  install: z.boolean().default(true),
})

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.servers.write')
  const { allocationId, install, ...body } = await readValidatedBody(event, bodySchema.parse)
  const db = useDb()

  let variables: Record<string, string> = {}
  let startup = body.startup || null
  let hasInstallHook = false
  if (body.templateId) {
    const row = await db.query.templates.findFirst({ where: eq(schema.templates.id, body.templateId) })
    if (!row) throw createError({ statusCode: 422, statusMessage: 'template not found' })
    const template = templateSchema.parse(row.definition)
    const images = Object.values(template.images)
    if (images.length && !images.includes(body.image)) {
      throw createError({ statusCode: 422, statusMessage: 'image is not offered by the template' })
    }
    const result = validateVariables(template.variables, body.variables)
    if (Object.keys(result.errors).length) {
      throw createError({ statusCode: 422, statusMessage: 'invalid variables', data: { errors: result.errors } })
    }
    variables = result.values
    startup ??= template.startup?.command ?? null
    hasInstallHook = !!template.hooks.install
  }
  if (!startup) throw createError({ statusCode: 422, statusMessage: 'startup command required' })
  if (install && hasInstallHook && !isNodeOnline(body.nodeId)) {
    throw createError({ statusCode: 409, statusMessage: 'node is offline, cannot install' })
  }

  const server = await db.transaction(async (tx) => {
    const owner = await tx.query.users.findFirst({ where: eq(schema.users.id, body.ownerId), columns: { id: true } })
    if (!owner) throw createError({ statusCode: 422, statusMessage: 'owner not found' })
    const node = await tx.query.nodes.findFirst({ where: eq(schema.nodes.id, body.nodeId), columns: { id: true } })
    if (!node) throw createError({ statusCode: 422, statusMessage: 'node not found' })

    const [created] = await tx
      .insert(schema.servers)
      .values({ ...body, startup, variables, primaryAllocationId: allocationId, status: 'offline' })
      .returning()

    // Claim the allocation atomically: it must belong to the node and be free.
    const claimed = await tx
      .update(schema.allocations)
      .set({ serverId: created!.id })
      .where(and(eq(schema.allocations.id, allocationId), eq(schema.allocations.nodeId, body.nodeId), isNull(schema.allocations.serverId)))
      .returning({ id: schema.allocations.id })
    if (!claimed.length) throw createError({ statusCode: 409, statusMessage: 'allocation not available on this node' })
    return created!
  })

  await usePanelHooks().callHook('server.created', { serverId: server.id })
  if (install && hasInstallHook) {
    // A failed install start is recorded on the server; creation still succeeded.
    await startInstall(server.id).catch(() => {})
  }
  setResponseStatus(event, 201)
  return { id: server.id }
})
