import { create } from '@bufbuild/protobuf'
import { InstallSpecSchema, ServerSpecSchema, type InstallSpec, type ServerSpec } from '@panel/protocol'
import { renderPlaceholders, templateSchema, type Template } from '@panel/shared'
import { asc, eq } from 'drizzle-orm'

const DAEMON_PARSERS = new Set(['properties', 'json', 'yaml', 'text'])

export interface LoadedServer {
  server: typeof schema.servers.$inferSelect
  template: Template | null
  allocations: (typeof schema.allocations.$inferSelect)[]
}

export async function loadServerForSpec(serverId: string): Promise<LoadedServer> {
  const row = await useDb().query.servers.findFirst({
    where: eq(schema.servers.id, serverId),
    with: {
      template: true,
      allocations: { orderBy: [asc(schema.allocations.port)] },
    },
  })
  if (!row) throw createError({ statusCode: 404, statusMessage: 'server not found' })
  const { template: tplRow, allocations, ...server } = row
  let template: Template | null = null
  if (tplRow) {
    const parsed = templateSchema.safeParse(tplRow.definition)
    if (!parsed.success) throw createError({ statusCode: 500, statusMessage: 'stored template is invalid' })
    template = parsed.data
  }
  // Primary allocation first: its port becomes SERVER_PORT.
  allocations.sort((a, b) => (a.id === server.primaryAllocationId ? -1 : b.id === server.primaryAllocationId ? 1 : 0))
  return { server, template, allocations }
}

/** Environment visible to the game server (Wings-compatible names). */
export function serverEnv(loaded: LoadedServer): Record<string, string> {
  const { server, allocations } = loaded
  const primary = allocations[0]
  return {
    ...server.variables,
    SERVER_MEMORY: String(server.memoryMb),
    SERVER_IP: primary?.ip ?? '0.0.0.0',
    SERVER_PORT: primary ? String(primary.port) : '',
    P_SERVER_ALLOCATION_LIMIT: '0',
    TZ: process.env.TZ ?? 'UTC',
  }
}

/** Builds the spec the daemon needs to run the server. The daemon keeps no DB. */
export function buildServerSpec(loaded: LoadedServer): ServerSpec {
  const { server, template, allocations } = loaded
  const env = serverEnv(loaded)
  const stop = template?.startup?.stop
  const startup = server.startup ?? template?.startup?.command ?? ''
  if (!server.image) throw createError({ statusCode: 409, statusMessage: 'server has no docker image' })

  return create(ServerSpecSchema, {
    id: server.id,
    image: server.image,
    startup,
    env,
    memoryMb: BigInt(server.memoryMb),
    cpuPercent: server.cpuPercent,
    diskMb: BigInt(server.diskMb),
    ports: allocations.map((a) => ({ ip: a.ip, port: a.port })),
    stop: typeof stop === 'string'
      ? { kind: { case: 'command', value: stop } }
      : stop
        ? { kind: { case: 'signal', value: stop.signal } }
        : { kind: { case: 'signal', value: 'SIGTERM' } },
    done: template?.startup?.done ?? [],
    configFiles: (template?.config_files ?? [])
      .filter((f) => DAEMON_PARSERS.has(f.parser))
      .map((f) => ({
        path: f.path,
        parser: f.parser,
        set: Object.fromEntries(Object.entries(f.set).map(([k, v]) => [k, renderPlaceholders(v, env)])),
      })),
  })
}

export function buildInstallSpec(template: Template | null): InstallSpec | null {
  const hook = template?.hooks.install
  if (!hook) return null
  return create(InstallSpecSchema, {
    image: hook.image ?? 'ghcr.io/pelican-eggs/installers:debian',
    entrypoint: hook.entrypoint,
    script: hook.script,
  })
}
