<script setup lang="ts">
const id = useRoute().params.id as string
const { data: server } = await useServerDetail(id)
const socket = inject(SERVER_SOCKET)!

const can = (p: string) => server.value?.permissions.includes(p) ?? false

const memoryPct = computed(() => {
  const s = socket.stats.value
  if (!s?.memoryLimit) return 0
  return Math.min(100, (s.memory / s.memoryLimit) * 100)
})
const cpuLimit = computed(() => server.value?.cpuPercent || 0)
const cpuPct = computed(() => {
  const s = socket.stats.value
  if (!s) return 0
  return cpuLimit.value ? Math.min(100, (s.cpu / cpuLimit.value) * 100) : Math.min(100, s.cpu)
})
const diskPct = computed(() => {
  const s = socket.stats.value
  const limit = (server.value?.diskMb ?? 0) * 1024 * 1024
  return s && limit ? Math.min(100, (s.disk / limit) * 100) : 0
})
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-[1fr_16rem]">
    <div class="min-w-0 space-y-2">
      <UAlert v-if="socket.error.value" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :title="socket.error.value" />
      <ServerConsole v-if="can('control.console')" :can-command="can('control.command')" />
      <UEmpty v-else icon="i-lucide-lock" title="Keine Berechtigung für die Konsole" />
    </div>

    <div class="space-y-3">
      <UCard :ui="{ body: 'p-3 sm:p-3' }">
        <p class="text-xs text-muted">CPU</p>
        <p class="text-lg font-semibold text-highlighted tabular-nums">
          {{ socket.stats.value ? socket.stats.value.cpu.toFixed(1) : '–' }} %
          <span class="text-xs font-normal text-muted">/ {{ cpuLimit || '∞' }} %</span>
        </p>
        <UProgress :model-value="cpuPct" size="xs" class="mt-1" />
      </UCard>
      <UCard :ui="{ body: 'p-3 sm:p-3' }">
        <p class="text-xs text-muted">Arbeitsspeicher</p>
        <p class="text-lg font-semibold text-highlighted tabular-nums">
          {{ formatBytes(socket.stats.value?.memory ?? 0) }}
          <span class="text-xs font-normal text-muted">/ {{ formatMb(server?.memoryMb ?? 0) }}</span>
        </p>
        <UProgress :model-value="memoryPct" size="xs" class="mt-1" />
      </UCard>
      <UCard :ui="{ body: 'p-3 sm:p-3' }">
        <p class="text-xs text-muted">Speicherplatz</p>
        <p class="text-lg font-semibold text-highlighted tabular-nums">
          {{ formatBytes(socket.stats.value?.disk ?? 0) }}
          <span class="text-xs font-normal text-muted">/ {{ formatMb(server?.diskMb ?? 0) }}</span>
        </p>
        <UProgress :model-value="diskPct" size="xs" class="mt-1" />
      </UCard>
      <UCard :ui="{ body: 'p-3 sm:p-3' }">
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt class="text-muted">Laufzeit</dt>
          <dd class="tabular-nums">{{ formatUptime(socket.stats.value?.uptimeMs ?? 0) }}</dd>
          <dt class="text-muted">Netz ↓</dt>
          <dd class="tabular-nums">{{ formatBytes(socket.stats.value?.netRx ?? 0) }}</dd>
          <dt class="text-muted">Netz ↑</dt>
          <dd class="tabular-nums">{{ formatBytes(socket.stats.value?.netTx ?? 0) }}</dd>
          <dt class="text-muted">Node</dt>
          <dd class="truncate">{{ server?.node?.name ?? '–' }}</dd>
          <dt v-if="server?.templateName" class="text-muted">Template</dt>
          <dd v-if="server?.templateName" class="truncate">{{ server.templateName }}</dd>
        </dl>
      </UCard>
    </div>
  </div>
</template>
