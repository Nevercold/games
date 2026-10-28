import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { SftpAuthRequestSchema, SftpAuthResponseSchema } from '@panel/protocol'
import { and, eq, sql } from 'drizzle-orm'

/**
 * SFTP logins: the daemon forwards credentials over the tunnel. Username
 * format is "<username>.<first 8 chars of the server id>" (like Pelican).
 * Only servers on the asking node are considered, so a daemon cannot use
 * this to probe passwords for other nodes' servers.
 */
export default defineNitroPlugin(() => {
  onDaemonRpc('sftp.auth', async (nodeId, header) => {
    const req = fromBinary(SftpAuthRequestSchema, header)
    const denied = () => new TunnelError(401, 'invalid credentials')

    const m = /^(.+)\.([0-9a-f]{8})$/i.exec(req.username)
    if (!m || !req.password) throw denied()
    const [, username, shortId] = m as unknown as [string, string, string]

    // Limit per user+ip and per ip, independent of the daemon's own limiter.
    if (rateLimited(`sftp:${username.toLowerCase()}:${req.remoteIp}`, 10) || rateLimited(`sftp-ip:${req.remoteIp}`, 30)) {
      throw new TunnelError(429, 'too many attempts')
    }

    const db = useDb()
    const user = await db.query.users.findFirst({
      where: eq(sql`lower(${schema.users.username})`, username.toLowerCase()),
      columns: { id: true, passwordHash: true },
    })
    const valid = user?.passwordHash
      ? await verifyPassword(user.passwordHash, req.password)
      : (await hashPassword(req.password), false)
    if (!user || !valid) throw denied()

    const server = await db.query.servers.findFirst({
      where: and(eq(schema.servers.nodeId, nodeId), sql`${schema.servers.id}::text like ${shortId.toLowerCase() + '%'}`),
      columns: { id: true, diskMb: true, status: true },
    })
    if (!server || server.status === 'suspended') throw denied()

    const actor = await loadActor(user.id)
    const access = actor ? await getServerAccess(actor, server.id) : null
    if (!access?.permissions.has('file.sftp')) throw denied()

    return toBinary(
      SftpAuthResponseSchema,
      create(SftpAuthResponseSchema, {
        serverId: server.id,
        permissions: [...access.permissions].filter((p) => p.startsWith('file.')),
        diskLimitBytes: BigInt(server.diskMb) * 1024n * 1024n,
      }),
    )
  })
})
