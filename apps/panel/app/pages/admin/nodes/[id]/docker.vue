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
  actionsColumn<Overview['images'][number]>(),
]
const volumeColumns: TableColumn<Overview['volumes'][number]>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'driver', header: 'Treiber' },
  { accessorKey: 'mountpoint', header: 'Mountpoint' },
  actionsColumn<Overview['volumes'][number]>(),
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

// --- actions (admin.docker.write) ------------------------------------------
const { can } = useMe()
const canWrite = computed(() => can('admin.docker.write'))
const toast = useToast()
const busy = ref<string | null>(null)

async function containerAction(c: Container, action: 'start' | 'stop' | 'restart' | 'kill' | 'remove') {
  busy.value = c.id
  try {
    await $fetch(`/api/admin/nodes/${id}/docker/container`, { method: 'POST', body: { container: c.id, action } })
    toast.add({ title: `${c.name}: ${action}`, color: 'success' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Aktion fehlgeschlagen', description: errorMessage(err), color: 'error' })
  } finally {
    busy.value = null
  }
}

const terminal = reactive({ open: false, container: '', name: '', shell: 'sh', key: 0 })
function openTerminal(c: Container, shell = 'sh') {
  Object.assign(terminal, { open: true, container: c.id, name: c.name, shell, key: terminal.key + 1 })
}

const toRemove = ref<Container | null>(null)

function containerMenu(c: Container) {
  const running = c.state === 'running'
  const items: object[][] = []
  if (canWrite.value && running) {
    items.push([
      { label: 'Terminal (sh)', icon: 'i-lucide-square-terminal', onSelect: () => openTerminal(c, 'sh') },
      { label: 'Terminal (bash)', icon: 'i-lucide-square-terminal', onSelect: () => openTerminal(c, 'bash') },
    ])
  }
  items.push([{ label: 'Logs', icon: 'i-lucide-scroll-text', onSelect: () => showLogs(c) }])
  if (canWrite.value && !c.managed) {
    items.push([
      ...(running
        ? [
            { label: 'Neustarten', icon: 'i-lucide-rotate-cw', onSelect: () => containerAction(c, 'restart') },
            { label: 'Stoppen', icon: 'i-lucide-square', onSelect: () => containerAction(c, 'stop') },
            { label: 'Hart beenden', icon: 'i-lucide-skull', onSelect: () => containerAction(c, 'kill') },
          ]
        : [{ label: 'Starten', icon: 'i-lucide-play', onSelect: () => containerAction(c, 'start') }]),
    ])
    items.push([{ label: 'Entfernen', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => (toRemove.value = c) }])
  }
  return items
}

// --- images -------------------------------------------------------------------
const pullRef = ref('')
const pulling = ref(false)
async function pull() {
  if (!pullRef.value.trim()) return
  pulling.value = true
  try {
    await $fetch(`/api/admin/nodes/${id}/docker/image`, { method: 'POST', body: { action: 'pull', ref: pullRef.value.trim() } })
    toast.add({ title: 'Image geladen', description: pullRef.value, color: 'success' })
    pullRef.value = ''
    await refresh()
  } catch (err) {
    toast.add({ title: 'Pull fehlgeschlagen', description: errorMessage(err), color: 'error' })
  } finally {
    pulling.value = false
  }
}
async function removeImage(img: Overview['images'][number]) {
  try {
    await $fetch(`/api/admin/nodes/${id}/docker/image`, { method: 'POST', body: { action: 'remove', id: img.id.replace(/^sha256:/, '') } })
    toast.add({ title: 'Image entfernt', color: 'success' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Entfernen fehlgeschlagen', description: errorMessage(err), color: 'error' })
  }
}

// --- volume browser --------------------------------------------------------------
const vb = reactive({ open: false, volume: '', path: '/', loading: false, error: '', entries: [] as { name: string; size: number; isDir: boolean }[], file: null as null | { path: string; content: string; binary: boolean; truncated: boolean } })
async function browse(volume: string, path = '/') {
  Object.assign(vb, { open: true, volume, path, loading: true, error: '', file: null })
  try {
    const res = await $fetch<{ entries: typeof vb.entries }>(`/api/admin/nodes/${id}/docker/volume`, { query: { volume, path } })
    vb.entries = res.entries
  } catch (err) {
    vb.error = errorMessage(err)
    vb.entries = []
  } finally {
    vb.loading = false
  }
}
async function openVolumeFile(name: string) {
  const path = (vb.path === '/' ? '' : vb.path) + '/' + name
  vb.loading = true
  try {
    const res = await $fetch<{ content: string; binary: boolean; truncated: boolean }>(`/api/admin/nodes/${id}/docker/volume`, { query: { volume: vb.volume, path, op: 'read' } })
    vb.file = { path, ...res }
  } catch (err) {
    vb.error = errorMessage(err)
  } finally {
    vb.loading = false
  }
}
const vbUp = () => browse(vb.volume, vb.path.split('/').slice(0, -1).join('/') || '/')
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
        v-if="!canWrite"
        class="shrink-0"
        icon="i-lucide-eye"
        variant="subtle"
        color="neutral"
        title="Nur-Lese-Ansicht"
        description="Für Container-Aktionen, Terminal und Images braucht deine Rolle das Recht „Docker steuern“."
      />
      <form v-if="tab === 'images' && canWrite" class="flex gap-2 shrink-0" @submit.prevent="pull">
        <UInput v-model="pullRef" placeholder="Image, z. B. ghcr.io/pterodactyl/yolks:java_21" class="flex-1 max-w-lg font-mono" />
        <UButton type="submit" icon="i-lucide-download" label="Pull" :loading="pulling" :disabled="!pullRef.trim()" />
      </form>

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
            <UDropdownMenu :items="containerMenu(row.original)" :content="{ align: 'end' }">
              <UButton icon="i-lucide-ellipsis-vertical" size="xs" color="neutral" variant="ghost" :loading="busy === row.original.id" :aria-label="`Aktionen für ${row.original.name}`" />
            </UDropdownMenu>
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
        <template #actions-cell="{ row }">
          <div v-if="canWrite" class="flex justify-end">
            <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" aria-label="Image entfernen" @click="removeImage(row.original)" />
          </div>
        </template>
      </UTable>

      <UTable v-else-if="tab === 'volumes'" :data="data?.volumes.filter((v) => match(v.name))" :columns="volumeColumns" :loading="status === 'pending'">
        <template #name-cell="{ row }"><span class="font-mono text-xs">{{ row.original.name }}</span></template>
        <template #mountpoint-cell="{ row }"><span class="font-mono text-xs text-muted">{{ row.original.mountpoint }}</span></template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end">
            <UButton icon="i-lucide-folder-search" size="xs" color="neutral" variant="ghost" label="Durchsuchen" @click="browse(row.original.name)" />
          </div>
        </template>
      </UTable>

      <UTable v-else :data="data?.networks.filter((n) => match(n.name, n.driver))" :columns="networkColumns" :loading="status === 'pending'" />
    </template>
  </UDashboardPanel>

  <UModal v-model:open="terminal.open" fullscreen :title="`Terminal · ${terminal.name}`" :ui="{ body: 'flex-1 min-h-0 flex flex-col p-2 sm:p-3' }">
    <template #body>
      <ContainerTerminal v-if="terminal.open" :key="terminal.key" :node-id="id" :container="terminal.container" :shell="terminal.shell" class="flex-1" />
    </template>
  </UModal>

  <UModal
    :open="!!toRemove"
    title="Container entfernen?"
    :description="`${toRemove?.name} wird gestoppt und gelöscht. Daten in Volumes bleiben erhalten.`"
    @update:open="(v: boolean) => { if (!v) toRemove = null }"
  >
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Abbrechen" @click="toRemove = null" />
        <UButton color="error" label="Entfernen" @click="toRemove && containerAction(toRemove, 'remove'); toRemove = null" />
      </div>
    </template>
  </UModal>

  <UModal v-model:open="vb.open" :title="`Volume · ${vb.volume}`" :ui="{ content: 'sm:max-w-4xl' }">
    <template #body>
      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <UButton icon="i-lucide-arrow-up" size="xs" color="neutral" variant="ghost" :disabled="vb.path === '/' && !vb.file" aria-label="Nach oben" @click="vb.file ? (vb.file = null) : vbUp()" />
          <span class="font-mono text-sm truncate">{{ vb.file?.path ?? vb.path }}</span>
          <UBadge label="nur lesen" size="sm" color="neutral" variant="subtle" class="ml-auto" />
        </div>
        <UAlert v-if="vb.error" color="error" variant="subtle" :title="vb.error" />
        <div v-if="vb.loading" class="text-sm text-muted">Lädt…</div>
        <template v-else-if="vb.file">
          <UAlert v-if="vb.file.binary" color="neutral" variant="subtle" title="Binärdatei, keine Vorschau" />
          <pre v-else class="text-xs font-mono bg-elevated rounded-md p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap">{{ vb.file.content }}</pre>
          <p v-if="vb.file.truncated" class="text-xs text-muted">Nur das erste MiB wird angezeigt.</p>
        </template>
        <ul v-else class="divide-y divide-default rounded-md border border-default">
          <li v-for="e in vb.entries" :key="e.name">
            <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-elevated/50 text-left" @click="e.isDir ? browse(vb.volume, (vb.path === '/' ? '' : vb.path) + '/' + e.name) : openVolumeFile(e.name)">
              <UIcon :name="e.isDir ? 'i-lucide-folder' : 'i-lucide-file'" class="size-4" :class="e.isDir ? 'text-primary' : 'text-muted'" />
              <span class="flex-1 truncate">{{ e.name }}</span>
              <span v-if="!e.isDir" class="text-xs text-muted tabular-nums">{{ formatBytes(e.size) }}</span>
            </button>
          </li>
          <li v-if="!vb.entries.length" class="px-3 py-4 text-sm text-muted text-center">Leer</li>
        </ul>
      </div>
    </template>
  </UModal>

  <UModal v-model:open="logsOpen" :title="`Logs · ${logsFor?.name ?? ''}`" :ui="{ content: 'sm:max-w-5xl' }">
    <template #body>
      <UAlert v-if="logsError" color="error" variant="subtle" :title="logsError" />
      <pre v-else class="text-xs font-mono bg-elevated rounded-md p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap">{{ logsLoading ? 'Lädt…' : logs || '(keine Ausgabe)' }}</pre>
    </template>
  </UModal>
</template>
