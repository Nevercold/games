type BadgeColor = 'success' | 'warning' | 'error' | 'neutral' | 'info' | 'primary'

export const SERVER_STATUS: Record<string, { label: string; color: BadgeColor; icon: string }> = {
  running: { label: 'Läuft', color: 'success', icon: 'i-lucide-circle-play' },
  starting: { label: 'Startet', color: 'info', icon: 'i-lucide-loader-circle' },
  stopping: { label: 'Stoppt', color: 'warning', icon: 'i-lucide-loader-circle' },
  offline: { label: 'Offline', color: 'neutral', icon: 'i-lucide-circle-stop' },
  installing: { label: 'Installiert', color: 'info', icon: 'i-lucide-download' },
  install_failed: { label: 'Installation fehlgeschlagen', color: 'error', icon: 'i-lucide-circle-alert' },
  suspended: { label: 'Gesperrt', color: 'error', icon: 'i-lucide-ban' },
  unknown: { label: 'Unbekannt', color: 'neutral', icon: 'i-lucide-circle-help' },
}

export function serverStatus(status: string) {
  return SERVER_STATUS[status] ?? SERVER_STATUS.unknown!
}

export function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`
}

export function formatUptime(ms: number) {
  if (!ms) return '–'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`
}

/** Tailwind classes for the palette colors used by groups/servers. */
export const COLOR_DOT: Record<string, string> = {
  neutral: 'bg-neutral-400', red: 'bg-red-500', orange: 'bg-orange-500', amber: 'bg-amber-500',
  yellow: 'bg-yellow-400', lime: 'bg-lime-500', green: 'bg-green-500', emerald: 'bg-emerald-500',
  teal: 'bg-teal-500', cyan: 'bg-cyan-500', sky: 'bg-sky-500', blue: 'bg-blue-500',
  indigo: 'bg-indigo-500', violet: 'bg-violet-500', purple: 'bg-purple-500', fuchsia: 'bg-fuchsia-500',
  pink: 'bg-pink-500', rose: 'bg-rose-500',
}

export const COLOR_BORDER: Record<string, string> = {
  neutral: 'border-l-neutral-400', red: 'border-l-red-500', orange: 'border-l-orange-500', amber: 'border-l-amber-500',
  yellow: 'border-l-yellow-400', lime: 'border-l-lime-500', green: 'border-l-green-500', emerald: 'border-l-emerald-500',
  teal: 'border-l-teal-500', cyan: 'border-l-cyan-500', sky: 'border-l-sky-500', blue: 'border-l-blue-500',
  indigo: 'border-l-indigo-500', violet: 'border-l-violet-500', purple: 'border-l-purple-500', fuchsia: 'border-l-fuchsia-500',
  pink: 'border-l-pink-500', rose: 'border-l-rose-500',
}
