<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

const route = useRoute()
const id = route.params.id as string
const toast = useToast()
const { can } = useMe()

const { data: node, refresh, error: loadError } = await useFetch(`/api/admin/nodes/${id}`)
if (loadError.value) throw createError({ statusCode: 404, statusMessage: 'Node nicht gefunden', fatal: true })

useHead({ title: () => node.value?.name ?? 'Node' })

usePolling(refresh, 10_000)

type Allocation = NonNullable<typeof node.value>['allocations'][number]
const allocColumns: TableColumn<Allocation>[] = [
  { accessorKey: 'ip', header: 'IP' },
  { accessorKey: 'port', header: 'Port' },
  { accessorKey: 'alias', header: 'Alias' },
  { accessorKey: 'serverId', header: 'Server' },
  actionsColumn<Allocation>(),
]

const serverNames = computed(() => new Map(node.value?.servers.map((s) => [s.id, s.name]) ?? []))

const sys = computed(() => (node.value?.systemInfo ?? {}) as Record<string, string | number | undefined>)

// --- allocations ---
const allocForm = reactive({ ip: '0.0.0.0', ports: '', alias: '' })
const addingAlloc = ref(false)
async function addAllocations() {
  addingAlloc.value = true
  try {
    const res = await $fetch(`/api/admin/nodes/${id}/allocations`, {
      method: 'POST',
      body: { ip: allocForm.ip, ports: allocForm.ports, alias: allocForm.alias || undefined },
    })
    toast.add({
      title: `${res.created} Allocation(s) angelegt`,
      description: res.skipped ? `${res.skipped} existierten bereits` : undefined,
      color: 'success',
    })
    allocForm.ports = ''
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  } finally {
    addingAlloc.value = false
  }
}

async function deleteAllocation(allocId: string) {
  try {
    await $fetch(`/api/admin/allocations/${allocId}`, { method: 'DELETE' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  }
}

// --- token rotation ---
const newToken = ref<string | null>(null)
const tokenOpen = ref(false)
const confirmRotate = ref(false)
async function rotateToken() {
  confirmRotate.value = false
  try {
    const res = await $fetch(`/api/admin/nodes/${id}/token`, { method: 'POST' })
    newToken.value = res.token
    tokenOpen.value = true
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  }
}

// --- delete ---
const confirmDelete = ref(false)
async function deleteNode() {
  try {
    await $fetch(`/api/admin/nodes/${id}`, { method: 'DELETE' })
    toast.add({ title: 'Node gelöscht', color: 'success' })
    await navigateTo('/admin/nodes')
  } catch (err) {
    confirmDelete.value = false
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  }
}
</script>

<template>
  <UDashboardPanel id="node-detail">
    <template #header>
      <UDashboardNavbar :title="node?.name">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton icon="i-lucide-arrow-left" color="neutral" variant="ghost" to="/admin/nodes" aria-label="Zurück" />
        </template>
        <template #trailing>
          <UBadge :color="node?.online ? 'success' : 'neutral'" variant="subtle">
            {{ node?.online ? 'online' : 'offline' }}
          </UBadge>
        </template>
        <template #right>
          <UButton v-if="can('admin.docker.read') && node?.dockerManagement" icon="i-lucide-container" color="neutral" variant="outline" label="Docker" :to="`/admin/nodes/${id}/docker`" />
          <template v-if="can('admin.nodes.write')">
            <UButton icon="i-lucide-key-round" color="neutral" variant="outline" label="Token erneuern" @click="confirmRotate = true" />
            <UButton icon="i-lucide-trash-2" color="error" variant="outline" label="Löschen" @click="confirmDelete = true" />
          </template>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="node" class="space-y-6">
        <div class="grid gap-4 md:grid-cols-2">
          <UCard>
            <template #header><p class="font-medium text-highlighted">Node</p></template>
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt class="text-muted">Adresse</dt><dd>{{ node.publicHost }}</dd>
              <dt class="text-muted">RAM</dt><dd>{{ formatMb(node.memoryMb) }}</dd>
              <dt class="text-muted">Disk</dt><dd>{{ formatMb(node.diskMb) }}</dd>
              <dt class="text-muted">Zuletzt gesehen</dt><dd>{{ node.online ? 'jetzt' : formatRelative(node.lastSeenAt) }}</dd>
              <dt class="text-muted">Beschreibung</dt><dd>{{ node.description || '–' }}</dd>
            </dl>
          </UCard>
          <UCard>
            <template #header><p class="font-medium text-highlighted">System</p></template>
            <dl v-if="node.daemonVersion" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt class="text-muted">Hostname</dt><dd>{{ sys.hostname ?? '–' }}</dd>
              <dt class="text-muted">Daemon</dt><dd>{{ node.daemonVersion }}</dd>
              <dt class="text-muted">OS / Arch</dt><dd>{{ sys.os ?? '–' }} / {{ sys.arch ?? '–' }}</dd>
              <dt class="text-muted">Kernel</dt><dd>{{ sys.kernel || '–' }}</dd>
              <dt class="text-muted">CPUs</dt><dd>{{ sys.cpuCount ?? '–' }}</dd>
              <dt class="text-muted">RAM gesamt</dt>
              <dd>{{ sys.memoryTotalBytes ? formatMb(Math.round(Number(sys.memoryTotalBytes) / 1048576)) : '–' }}</dd>
              <dt class="text-muted">Docker</dt><dd>{{ sys.dockerVersion || 'nicht erreichbar' }}</dd>
            </dl>
            <p v-else class="text-sm text-muted">Der Daemon hat sich noch nie verbunden.</p>
          </UCard>
        </div>

        <UCard>
          <template #header><p class="font-medium text-highlighted">Allocations</p></template>
          <form v-if="can('admin.nodes.write')" class="flex flex-wrap items-end gap-3 mb-4" @submit.prevent="addAllocations">
            <UFormField label="IP">
              <UInput v-model="allocForm.ip" class="w-40" />
            </UFormField>
            <UFormField label="Ports" help="z. B. 25565 oder 25565-25570">
              <UInput v-model="allocForm.ports" class="w-56" required />
            </UFormField>
            <UFormField label="Alias">
              <UInput v-model="allocForm.alias" class="w-48" />
            </UFormField>
            <UButton type="submit" icon="i-lucide-plus" label="Hinzufügen" :loading="addingAlloc" />
          </form>
          <UTable :data="node.allocations" :columns="allocColumns">
            <template #alias-cell="{ row }">{{ row.original.alias || '–' }}</template>
            <template #serverId-cell="{ row }">
              <span v-if="row.original.serverId">{{ serverNames.get(row.original.serverId) ?? row.original.serverId }}</span>
              <span v-else class="text-dimmed">frei</span>
            </template>
            <template #actions-cell="{ row }">
              <div class="flex justify-end">
                <UButton
                  v-if="!row.original.serverId && can('admin.nodes.write')"
                  icon="i-lucide-trash-2"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  aria-label="Allocation löschen"
                  @click="deleteAllocation(row.original.id)"
                />
              </div>
            </template>
            <template #empty>
              <p class="text-sm text-muted py-4 text-center">Noch keine Allocations.</p>
            </template>
          </UTable>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="confirmRotate" title="Token erneuern?" description="Der laufende Daemon wird sofort getrennt und braucht das neue Token.">
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Abbrechen" @click="confirmRotate = false" />
        <UButton color="warning" label="Erneuern" @click="rotateToken" />
      </div>
    </template>
  </UModal>

  <UModal v-model:open="tokenOpen" title="Neues Token">
    <template #body>
      <NodeTokenDisplay v-if="newToken" :token="newToken" />
    </template>
    <template #footer>
      <div class="flex justify-end w-full">
        <UButton label="Fertig" @click="tokenOpen = false; newToken = null" />
      </div>
    </template>
  </UModal>

  <UModal v-model:open="confirmDelete" title="Node löschen?" description="Das geht nur, wenn keine Server mehr auf der Node liegen.">
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Abbrechen" @click="confirmDelete = false" />
        <UButton color="error" label="Löschen" @click="deleteNode" />
      </div>
    </template>
  </UModal>
</template>
