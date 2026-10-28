import { templateSchema } from '@panel/shared'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { server, permissions, full } = await requireServerPermission(event, id)
  const db = useDb()

  const [node, owner, primary, templateRow] = await Promise.all([
    db.query.nodes.findFirst({ where: eq(schema.nodes.id, server.nodeId), columns: { id: true, name: true, publicHost: true } }),
    db.query.users.findFirst({ where: eq(schema.users.id, server.ownerId), columns: { id: true, username: true } }),
    server.primaryAllocationId
      ? db.query.allocations.findFirst({ where: eq(schema.allocations.id, server.primaryAllocationId) })
      : undefined,
    server.templateId ? db.query.templates.findFirst({ where: eq(schema.templates.id, server.templateId) }) : undefined,
  ])

  const template = templateRow ? templateSchema.safeParse(templateRow.definition) : null
  const canReadStartup = permissions.has('startup.read')
  const variables = canReadStartup && template?.success
    ? template.data.variables
        .filter((v) => full || v.user_viewable)
        .map((v) => ({ ...v, value: v.type === 'secret' && !full ? '••••••' : (server.variables[v.env] ?? '') }))
    : []

  return {
    id: server.id,
    name: server.name,
    description: server.description,
    status: server.status,
    statusMessage: server.statusMessage,
    memoryMb: server.memoryMb,
    diskMb: server.diskMb,
    cpuPercent: server.cpuPercent,
    image: canReadStartup ? server.image : null,
    startup: canReadStartup ? server.startup : null,
    templateName: templateRow?.name ?? null,
    node: node ? { ...node, online: isNodeOnline(node.id) } : null,
    owner,
    address: primary && node ? `${node.publicHost}:${primary.port}` : null,
    permissions: [...permissions],
    isOwner: full,
    variables,
  }
})
