import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

const bodySchema = z.object({
  ip: z.union([z.ipv4(), z.ipv6()]).default('0.0.0.0'),
  /** Single port "25565", range "25565-25570" or list "25565,25566". */
  ports: z.string().trim().min(1).max(200),
  alias: z.string().trim().max(255).optional(),
})

const MAX_PORTS_PER_REQUEST = 1000

function parsePorts(input: string): number[] {
  const result = new Set<number>()
  for (const part of input.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part)
    if (!m) throw createError({ statusCode: 422, statusMessage: `invalid port spec "${part}"` })
    const from = Number(m[1])
    const to = m[2] ? Number(m[2]) : from
    if (from < 1 || to > 65535 || from > to) {
      throw createError({ statusCode: 422, statusMessage: `invalid port range "${part}"` })
    }
    if (to - from + 1 + result.size > MAX_PORTS_PER_REQUEST) {
      throw createError({ statusCode: 422, statusMessage: `at most ${MAX_PORTS_PER_REQUEST} ports per request` })
    }
    for (let p = from; p <= to; p++) result.add(p)
  }
  return [...result]
}

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.nodes.write')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const body = await readValidatedBody(event, bodySchema.parse)
  const ports = parsePorts(body.ports)

  const node = await useDb().query.nodes.findFirst({ where: eq(schema.nodes.id, id), columns: { id: true } })
  if (!node) throw createError({ statusCode: 404, statusMessage: 'node not found' })

  const inserted = await useDb()
    .insert(schema.allocations)
    .values(ports.map((port) => ({ nodeId: id, ip: body.ip, port, alias: body.alias })))
    .onConflictDoNothing()
    .returning({ id: schema.allocations.id })

  return { created: inserted.length, skipped: ports.length - inserted.length }
})
