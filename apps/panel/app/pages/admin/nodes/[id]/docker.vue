<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

const id = useRoute().params.id as string
useHead({ title: 'Docker' })

interface Overview {
  containers: { id: string; name: string; image: string; state: string; status: string; created: number; ports: string[]; managed: boolean; serverId: string | null }[]
  images: { id: string; tags: string[]; size: number; created: number; containers: number }[]
  volumes: { name: string; driver: string; mountpoint: string; createdAt: string }[]
  networks: { id: string; name: string; driver: string; scope: string; containers: number }[]
}

const { data: node } = await useFetch<{ name: string }>(`/api/admin/nodes/${id}`)
const { data, error, status, refresh } = await useFetch<Overview>(`/api/admin/nodes/${id}/docker`, { lazy: true })

const tab = ref('containers')
const tabs = computed(() => [
  { label: `Container (${data.value?.containers.length ?? 0})`, value: 'containers', icon: 'i-lucide-box' },
  { label: `Images (${data.value?.images.length ?? 0})`, value: 'images', icon: 'i-lucide-layers' },
  { label: `Volumes (${data.value?.volumes.length ?? 0})`, value: 'volumes', icon: 'i-lucide-hard-drive' },
  { label: `Netzwerke (${data.value?.networks.length ?? 0})`, value: 'networks', icon: 'i-lucide-network' },
])

const filter = ref('')
const match = (...fields: (string | undefined)[]) => {
  const q = filter.value.trim().toLowerCase()
  return !q || fields.some((f) => f?.toLowerCase().includes(q))
}

type Container = Overview['containers'][number]
const containerColumns: TableColumn<Container>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'state', header: 'Status' },
  { accessorKey: 'image', header: 'Image' },
  { accessorKey: 'ports', header: 'Ports' },
  actionsColumn<Container>(),
]
const imageColumns: TableColumn<Overview['images'][number]>[] = [
  { accessorKey: 'tags', header: 'Tags' },
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'size', header: 'Größe' },
  { accessorKey: 'containers', header: 'Container' },
  { accessorKey: 'created', header: 'Erstellt' },
]
const volumeColumns: TableColumn<Overview['volumes'][number]>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'driver', header: 'Treiber' },
  { accessorKey: 'mountpoint', header: 'Mountpoint' },
]
const networkColumns: TableColumn<Overview['networks'][number]>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'driver', header: 'Treiber' },
  { accessorKey: 'scope', header: 'Scope' },
  { accessorKey: 'containers', header: 'Container' },
]

const stateColor = (s: string) => (s === 'running' ? 'success' : s === 'exited' ? 'neutral' : s === 'restarting' ? 'warning' : 'info') as 'success' | 'neutral' | 'warning' | 'info'

// --- logs ---
const logsOpen = ref(false)
const logsFor = ref<Container | null>(null)
const logs = ref('')
const logsLoading = ref(false)
const logsError = ref('')
async function showLogs(c: Container) {
  logsFor.value = c
  logsOpen.value = true
  logsLoading.value = true
  logsError.value = ''
  logs.value = ''
  try {
    const res = await $fetch<{ logs: string }>(`/api/admin/nodes/${id}/docker-logs`, { query: { container: c.id, tail: 500 } })
    logs.value = res.logs
  } catch (err) {
    logsError.value = errorMessage(err)
  } finally {
    logsLoading.value = false
  }
}

const shortId = (s: string) => s.replace(/^sha256:/, '').slice(0, 12)
</script>

<template>
  <UDashboardPanel id="node-docker">
    <template #header>
      <UDashboardNavbar :title="`Docker · ${node?.name ?? ''}`">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton icon="i-lucide-arrow-left" color="neutral" variant="ghost" :to="`/admin/nodes/${id}`" aria-label="Zurück" />
        </template>
        <template #right>
          <UButton icon="i-lucide-refresh-cw" color="neutral" variant="outline" label="Aktualisieren" :loading="status === 'pending'" @click="refresh()" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <template #left>
          <UTabs v-model="tab" :items="tabs" :content="false" size="sm" variant="link" />
        </template>
        <template #right>
          <UInput v-model="filter" icon="i-lucide-search" placeholder="Filtern…" size="sm" class="w-48" />
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert v-if="error" class="shrink-0" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="errorMessage(error, 'Docker-Daten nicht verfügbar')" />
      <UAlert
        class="shrink-0"
        icon="i-lucide-eye"
        variant="subtle"
        color="neutral"
        title="Nur-Lese-Ansicht"
        description="Steuerung von Containern, Image-Pulls und Stacks folgen in den nächsten Phasen."
      />

      <UTable v-if="tab === 'containers'" :data="data?.containers.filter((c) => match(c.name, c.image, c.state))" :columns="containerColumns" :loading="status === 'pending'">
        <template #name-cell="{ row }">
          <div class="flex items-center gap-2">
            <span class="font-medium text-highlighted">{{ row.original.name }}</span>
            <UBadge v-if="row.original.managed" label="Panel" size="sm" variant="subtle" />
          </div>
          <p class="text-xs text-muted font-mono">{{ shortId(row.original.id) }}</p>
        </template>
        <template #state-cell="{ row }">
          <UBadge :color="stateColor(row.original.state)" variant="subtle">{{ row.original.state }}</UBadge>
          <p class="text-xs text-muted mt-0.5">{{ row.original.status }}</p>
        </template>
        <template #image-cell="{ row }"><span class="font-mono text-xs">{{ row.original.image }}</span></template>
        <template #ports-cell="{ row }">
          <div>
            <span v-for="p in row.original.ports" :key="p" class="block font-mono text-xs">{{ p }}</span>
            <span v-if="!row.original.ports.length" class="text-dimmed">–</span>
          </div>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UButton v-if="row.original.serverId" icon="i-lucide-external-link" size="xs" color="neutral" variant="ghost" :to="`/servers/${row.original.serverId}`" aria-label="Server öffnen" />
            <UButton icon="i-lucide-scroll-text" size="xs" color="neutral" variant="ghost" aria-label="Logs anzeigen" @click="showLogs(row.original)" />
          </div>
        </template>
      </UTable>

      <UTable v-else-if="tab === 'images'" :data="data?.images.filter((i) => match(...i.tags, i.id))" :columns="imageColumns" :loading="status === 'pending'">
        <template #tags-cell="{ row }">
          <div>
            <span v-for="t in row.original.tags.length ? row.original.tags : ['<none>']" :key="t" class="block font-mono text-xs">{{ t }}</span>
          </div>
        </template>
        <template #id-cell="{ row }"><span class="font-mono text-xs">{{ shortId(row.original.id) }}</span></template>
        <template #size-cell="{ row }">{{ formatBytes(row.original.size) }}</template>
        <template #containers-cell="{ row }">{{ row.original.containers >= 0 ? row.original.containers : '–' }}</template>
        <template #created-cell="{ row }">{{ formatRelative(new Date(row.original.created * 1000)) }}</template>
      </UTable>

      <UTable v-else-if="tab === 'volumes'" :data="data?.volumes.filter((v) => match(v.name))" :columns="volumeColumns" :loading="status === 'pending'">
        <template #name-cell="{ row }"><span class="font-mono text-xs">{{ row.original.name }}</span></template>
        <template #mountpoint-cell="{ row }"><span class="font-mono text-xs text-muted">{{ row.original.mountpoint }}</span></template>
      </UTable>

      <UTable v-else :data="data?.networks.filter((n) => match(n.name, n.driver))" :columns="networkColumns" :loading="status === 'pending'" />
    </template>
  </UDashboardPanel>

  <UModal v-model:open="logsOpen" :title="`Logs · ${logsFor?.name ?? ''}`" :ui="{ content: 'sm:max-w-5xl' }">
    <template #body>
      <UAlert v-if="logsError" color="error" variant="subtle" :title="logsError" />
      <pre v-else class="text-xs font-mono bg-elevated rounded-md p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap">{{ logsLoading ? 'Lädt…' : logs || '(keine Ausgabe)' }}</pre>
    </template>
  </UModal>
</template>
