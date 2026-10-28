import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}

// ---------------------------------------------------------------------------
// Users & roles
// ---------------------------------------------------------------------------

/** Admin roles (RBAC). Permissions are ids from shared/permissions.ts. */
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description'),
  permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
  ...timestamps,
})

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    username: text('username').notNull(),
    passwordHash: text('password_hash'),
    /** Superadmin: every permission, can manage other admins. */
    isAdmin: boolean('is_admin').notNull().default(false),
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    uniqueIndex('users_username_unique').on(sql`lower(${t.username})`),
  ],
)

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export const nodes = pgTable('nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  /** Public address players use to reach game ports (IP or hostname). */
  publicHost: text('public_host').notNull(),
  /** sha256(secret) of the node token. The secret itself is only shown once. */
  tokenHash: text('token_hash').notNull(),
  memoryMb: integer('memory_mb').notNull().default(0),
  diskMb: integer('disk_mb').notNull().default(0),
  /** Allow generic Docker management (containers, stacks) on this node. */
  dockerManagement: boolean('docker_management').notNull().default(true),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  /** System info reported by the daemon in the last tunnel handshake. */
  systemInfo: jsonb('system_info').$type<Record<string, unknown>>(),
  daemonVersion: text('daemon_version'),
  ...timestamps,
})

export const allocations = pgTable(
  'allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    ip: text('ip').notNull().default('0.0.0.0'),
    port: integer('port').notNull(),
    alias: text('alias'),
    serverId: uuid('server_id').references((): any => servers.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('allocations_node_ip_port_unique').on(t.nodeId, t.ip, t.port)],
)

// ---------------------------------------------------------------------------
// Templates (replace Pelican eggs, see PLAN.md)
// ---------------------------------------------------------------------------

export const templates = pgTable('templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  /** Full template document, validated with @panel/shared templateSchema. */
  definition: jsonb('definition').notNull(),
  ...timestamps,
})

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export const serverStatus = pgEnum('server_status', [
  'installing',
  'install_failed',
  'offline',
  'starting',
  'running',
  'stopping',
  'suspended',
])

export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  nodeId: uuid('node_id')
    .notNull()
    .references(() => nodes.id, { onDelete: 'restrict' }),
  templateId: uuid('template_id').references(() => templates.id, { onDelete: 'set null' }),
  image: text('image'),
  startup: text('startup'),
  memoryMb: integer('memory_mb').notNull().default(1024),
  diskMb: integer('disk_mb').notNull().default(5120),
  cpuPercent: integer('cpu_percent').notNull().default(100),
  variables: jsonb('variables').$type<Record<string, string>>().notNull().default({}),
  status: serverStatus('status').notNull().default('installing'),
  /** Last error/info message, e.g. why an install failed. */
  statusMessage: text('status_message'),
  primaryAllocationId: uuid('primary_allocation_id'),
  /** Max. number of backups kept; the oldest unlocked one rotates out. 0 = backups disabled. */
  backupLimit: integer('backup_limit').notNull().default(3),
  /** Backup target; null uses the default target. */
  backupTargetId: uuid('backup_target_id').references(() => backupTargets.id, { onDelete: 'set null' }),
  ...timestamps,
})

/** Users with access to someone else's server (PLAN.md "Berechtigungen"). */
export const serverSubusers = pgTable(
  'server_subusers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [uniqueIndex('server_subusers_server_user_unique').on(t.serverId, t.userId), index('server_subusers_user_idx').on(t.userId)],
)

// ---------------------------------------------------------------------------
// Per-user organisation: groups, order, colors
// ---------------------------------------------------------------------------

export const serverGroups = pgTable(
  'server_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('neutral'),
    sortOrder: integer('sort_order').notNull().default(0),
    collapsed: boolean('collapsed').notNull().default(false),
    ...timestamps,
  },
  (t) => [index('server_groups_user_idx').on(t.userId)],
)

export const userServerPrefs = pgTable(
  'user_server_prefs',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').references(() => serverGroups.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    color: text('color'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.serverId] })],
)

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export const backupTargetType = pgEnum('backup_target_type', ['local', 's3', 'sftp'])

export const backupTargets = pgTable('backup_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  type: backupTargetType('type').notNull(),
  /** AES-256-GCM encrypted JSON config incl. credentials (utils/crypto.ts). */
  config: text('config').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  ...timestamps,
})

export const backupStatus = pgEnum('backup_status', ['pending', 'completed', 'failed'])

export const backups = pgTable(
  'backups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => backupTargets.id, { onDelete: 'restrict' }),
    /** Node that wrote the archive; "local" targets only exist there. */
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /** Object key inside the target. */
    key: text('key').notNull(),
    status: backupStatus('status').notNull().default('pending'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    sha256: text('sha256'),
    ignore: text('ignore').array().notNull().default(sql`'{}'::text[]`),
    /** Locked backups are never rotated out or deleted. */
    locked: boolean('locked').notNull().default(false),
    restoring: boolean('restoring').notNull().default(false),
    error: text('error'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('backups_server_idx').on(t.serverId, t.createdAt),
    // At most one backup in progress per server.
    uniqueIndex('backups_one_pending').on(t.serverId).where(sql`status = 'pending'`),
  ],
)

// ---------------------------------------------------------------------------
// Settings (key/value, e.g. branding)
// ---------------------------------------------------------------------------

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamps.updatedAt,
})

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const nodesRelations = relations(nodes, ({ many }) => ({
  allocations: many(allocations),
  servers: many(servers),
}))

export const allocationsRelations = relations(allocations, ({ one }) => ({
  node: one(nodes, { fields: [allocations.nodeId], references: [nodes.id] }),
  server: one(servers, { fields: [allocations.serverId], references: [servers.id] }),
}))

export const serversRelations = relations(servers, ({ one, many }) => ({
  owner: one(users, { fields: [servers.ownerId], references: [users.id] }),
  node: one(nodes, { fields: [servers.nodeId], references: [nodes.id] }),
  template: one(templates, { fields: [servers.templateId], references: [templates.id] }),
  allocations: many(allocations),
  subusers: many(serverSubusers),
}))

export const usersRelations = relations(users, ({ one }) => ({
  role: one(roles, { fields: [users.roleId], references: [roles.id] }),
}))

export const serverSubusersRelations = relations(serverSubusers, ({ one }) => ({
  server: one(servers, { fields: [serverSubusers.serverId], references: [servers.id] }),
  user: one(users, { fields: [serverSubusers.userId], references: [users.id] }),
}))
