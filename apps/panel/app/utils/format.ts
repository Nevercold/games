export function formatMb(mb: number) {
  if (mb <= 0) return 'unbegrenzt'
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GiB` : `${mb} MiB`
}

export function formatRelative(date: string | Date | null | undefined) {
  if (!date) return 'nie'
  const diff = Date.now() - new Date(date).getTime()
  const s = Math.round(diff / 1000)
  if (s < 60) return 'gerade eben'
  const m = Math.round(s / 60)
  if (m < 60) return `vor ${m} Min.`
  const h = Math.round(m / 60)
  if (h < 24) return `vor ${h} Std.`
  return new Date(date).toLocaleDateString('de-DE')
}

/** Extracts a human readable message from a $fetch error. */
export function errorMessage(err: unknown, fallback = 'Unbekannter Fehler') {
  const e = err as { data?: { statusMessage?: string; message?: string }; statusMessage?: string }
  return e?.data?.statusMessage ?? e?.data?.message ?? e?.statusMessage ?? fallback
}
