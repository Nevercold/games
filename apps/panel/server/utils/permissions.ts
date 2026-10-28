import { and, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import {
  ADMIN_PERMISSIONS,
  SERVER_PERMISSIONS,
  type AdminPermission,
  type ServerPermission,
} from '#shared/permissions'

/**
 * Permission checks (PLAN.md "Berechtigungen"). The session only proves who
 * the user is; roles and flags are re-read from the database on every check
 * so revoked rights take effect immediately.
 */

export interface Actor {
  id: string
  username: string
  isAdmin: boolean
  adminPermissions: Set<AdminPermission>
}

export async function loadActor(userId: string): Promise<Actor | null> {
  const user = await useDb().query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { id: true, username: true, isAdmin: true },
    with: { role: { columns: { permissions: true } } },
  })
  if (!user) return null
  const perms = user.isAdmin
    ? ADMIN_PERMISSIONS
    : (user.role?.permissions ?? []).filter((p): p is AdminPermission => (ADMIN_PERMISSIONS as string[]).includes(p))
  return { id: user.id, username: user.username, isAdmin: user.isAdmin, adminPermissions: new Set(perms) }
}

/** Resolves the signed-in user; 401 if the session is gone or the user was deleted. */
export async function requireActor(event: H3Event | Request): Promise<Actor> {
  const session = await requireUserSession(event as H3Event)
  const actor = await loadActor(session.user.id)
  if (!actor) throw createError({ statusCode: 401, statusMessage: 'user no longer exists' })
  return actor
}

export async function requireAdminPermission(event: H3Event, permission: AdminPermission): Promise<Actor> {
  const actor = await requireActor(event)
  if (!actor.adminPermissions.has(permission)) {
    throw createError({ statusCode: 403, statusMessage: `missing permission ${permission}` })
  }
  return actor
}

export async function requireSuperadmin(event: H3Event): Promise<Actor> {
  const actor = await requireActor(event)
  if (!actor.isAdmin) throw createError({ statusCode: 403, statusMessage: 'superadmin only' })
  return actor
}

/**
 * A role may only be assigned by someone who holds every permission in it,
 * otherwise users.write would allow privilege escalation.
 */
export async function assertRoleAssignable(actor: Actor, roleId: string | null) {
  if (!roleId) return
  const role = await useDb().query.roles.findFirst({ where: eq(schema.roles.id, roleId), columns: { permissions: true } })
  if (!role) throw createError({ statusCode: 422, statusMessage: 'role not found' })
  const missing = role.permissions.filter((p) => !actor.adminPermissions.has(p as AdminPermission))
  if (missing.length) {
    throw createError({ statusCode: 403, statusMessage: `cannot assign a role with permissions you lack: ${missing.join(', ')}` })
  }
}

export interface ServerAccess {
  server: typeof schema.servers.$inferSelect
  permissions: Set<ServerPermission>
  /** Owner, superadmin or admin with admin.servers.write. */
  full: boolean
}

/**
 * Returns the actor's access to a server or null. Unknown and forbidden
 * servers look the same to the caller (no existence leak).
 */
export async function getServerAccess(actor: Actor, serverId: string): Promise<ServerAccess | null> {
  const server = await useDb().query.servers.findFirst({ where: eq(schema.servers.id, serverId) })
  if (!server) return null

  if (server.ownerId === actor.id || actor.adminPermissions.has('admin.servers.write')) {
    return { server, permissions: new Set(SERVER_PERMISSIONS), full: true }
  }
  const sub = await useDb().query.serverSubusers.findFirst({
    where: and(eq(schema.serverSubusers.serverId, serverId), eq(schema.serverSubusers.userId, actor.id)),
    columns: { permissions: true },
  })
  if (sub) {
    const perms = sub.permissions.filter((p): p is ServerPermission => (SERVER_PERMISSIONS as string[]).includes(p))
    return { server, permissions: new Set(perms), full: false }
  }
  if (actor.adminPermissions.has('admin.servers.read')) {
    // Read-only admins may look but not touch.
    return { server, permissions: new Set(['control.console', 'startup.read', 'user.read']), full: false }
  }
  return null
}

/** Loads the server and checks one permission (404 when there is no access at all). */
export async function requireServerPermission(
  event: H3Event,
  serverId: string,
  permission?: ServerPermission,
): Promise<ServerAccess & { actor: Actor }> {
  const actor = await requireActor(event)
  const access = await getServerAccess(actor, serverId)
  if (!access) throw createError({ statusCode: 404, statusMessage: 'server not found' })
  if (permission && !access.permissions.has(permission)) {
    throw createError({ statusCode: 403, statusMessage: `missing permission ${permission}` })
  }
  return { ...access, actor }
}
