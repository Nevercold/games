/**
 * Permission catalog (PLAN.md "Berechtigungen"). Checks always happen on the
 * server; the UI only hides what the user cannot do.
 */

export interface PermissionDef {
  id: string
  label: string
  description?: string
}

export interface PermissionGroup {
  id: string
  label: string
  permissions: PermissionDef[]
}

export const ADMIN_PERMISSION_GROUPS = [
  {
    id: 'servers',
    label: 'Server',
    permissions: [
      { id: 'admin.servers.read', label: 'Alle Server sehen' },
      { id: 'admin.servers.write', label: 'Server anlegen und verwalten', description: 'Inklusive Konsole und Steuerung aller Server' },
      { id: 'admin.servers.delete', label: 'Server löschen' },
    ],
  },
  {
    id: 'nodes',
    label: 'Nodes',
    permissions: [
      { id: 'admin.nodes.read', label: 'Nodes sehen' },
      { id: 'admin.nodes.write', label: 'Nodes und Allocations verwalten', description: 'Inklusive Token-Erneuerung' },
      { id: 'admin.docker.read', label: 'Docker-Bereich ansehen', description: 'Container, Images, Volumes, Netzwerke und Logs' },
      { id: 'admin.docker.write', label: 'Docker steuern', description: 'Container starten/stoppen/entfernen, Terminal, Images pullen und löschen. Entspricht Root-Zugriff auf die Node.' },
    ],
  },
  {
    id: 'templates',
    label: 'Templates',
    permissions: [
      { id: 'admin.templates.read', label: 'Templates sehen' },
      { id: 'admin.templates.write', label: 'Templates importieren und löschen' },
    ],
  },
  {
    id: 'users',
    label: 'Benutzer',
    permissions: [
      { id: 'admin.users.read', label: 'Benutzer sehen' },
      { id: 'admin.users.write', label: 'Benutzer anlegen und Rollen zuweisen' },
      { id: 'admin.roles.write', label: 'Rollen verwalten' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    permissions: [
      { id: 'admin.settings.write', label: 'Branding und Einstellungen ändern' },
      { id: 'admin.backups.write', label: 'Backup-Ziele verwalten', description: 'Inklusive Zugangsdaten für S3 und SFTP' },
      { id: 'admin.plugins.read', label: 'Plugins sehen' },
    ],
  },
] as const satisfies readonly PermissionGroup[]

export const SERVER_PERMISSION_GROUPS = [
  {
    id: 'control',
    label: 'Steuerung',
    permissions: [
      { id: 'control.console', label: 'Konsole ansehen' },
      { id: 'control.command', label: 'Befehle senden' },
      { id: 'control.start', label: 'Starten' },
      { id: 'control.stop', label: 'Stoppen' },
      { id: 'control.restart', label: 'Neustarten' },
      { id: 'control.kill', label: 'Hart beenden' },
    ],
  },
  {
    id: 'file',
    label: 'Dateien',
    permissions: [
      { id: 'file.read', label: 'Verzeichnisse auflisten' },
      { id: 'file.read-content', label: 'Dateien ansehen und herunterladen' },
      { id: 'file.create', label: 'Dateien hochladen und anlegen' },
      { id: 'file.update', label: 'Dateien bearbeiten und umbenennen' },
      { id: 'file.delete', label: 'Dateien löschen' },
      { id: 'file.archive', label: 'Archive erstellen und entpacken' },
      { id: 'file.sftp', label: 'SFTP-Zugang', description: 'Gilt mit den obigen Datei-Rechten' },
    ],
  },
  {
    id: 'startup',
    label: 'Startparameter',
    permissions: [
      { id: 'startup.read', label: 'Variablen ansehen' },
      { id: 'startup.update', label: 'Variablen ändern' },
    ],
  },
  {
    id: 'backup',
    label: 'Backups',
    permissions: [
      { id: 'backup.read', label: 'Backups ansehen' },
      { id: 'backup.create', label: 'Backups erstellen' },
      { id: 'backup.restore', label: 'Backups wiederherstellen', description: 'Überschreibt Serverdateien' },
      { id: 'backup.download', label: 'Backups herunterladen' },
      { id: 'backup.delete', label: 'Backups löschen und sperren' },
    ],
  },
  {
    id: 'settings',
    label: 'Einstellungen',
    permissions: [{ id: 'settings.reinstall', label: 'Neu installieren' }],
  },
  {
    id: 'user',
    label: 'Benutzer',
    permissions: [
      { id: 'user.read', label: 'Subuser ansehen' },
      { id: 'user.write', label: 'Subuser verwalten' },
    ],
  },
] as const satisfies readonly PermissionGroup[]

type IdsOf<G extends readonly PermissionGroup[]> = G[number]['permissions'][number]['id']

export type AdminPermission = IdsOf<typeof ADMIN_PERMISSION_GROUPS>
export type ServerPermission = IdsOf<typeof SERVER_PERMISSION_GROUPS>

export const ADMIN_PERMISSIONS = ADMIN_PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.id)) as AdminPermission[]
export const SERVER_PERMISSIONS = SERVER_PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.id)) as ServerPermission[]

export function isAdminPermission(p: string): p is AdminPermission {
  return (ADMIN_PERMISSIONS as string[]).includes(p)
}

export function isServerPermission(p: string): p is ServerPermission {
  return (SERVER_PERMISSIONS as string[]).includes(p)
}

/** Power actions and the permission each one needs. */
export const POWER_PERMISSION = {
  start: 'control.start',
  stop: 'control.stop',
  restart: 'control.restart',
  kill: 'control.kill',
} as const satisfies Record<string, ServerPermission>

export type PowerAction = keyof typeof POWER_PERMISSION

/** Colors offered for groups and servers (Nuxt UI palette names). */
export const ORG_COLORS = [
  'neutral', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
] as const

export type OrgColor = (typeof ORG_COLORS)[number]
