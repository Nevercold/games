<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

useHead({ title: 'Server' })
const toast = useToast()
const { can } = useMe()

interface ServerRow {
  id: string
  name: string
  status: string
  memoryMb: number
  diskMb: number
  cpuPercent: number
  owner: { id: string; username: string }
  node: { id: string; name: string; publicHost: string }
  allocations: { id: string; ip: string; port: number }[]
}
interface TemplateRow {
  id: string
  name: string
  images: Record<string, string>
  startup: string
  hasInstall: boolean
  resources: { memory_mb?: number; disk_mb?: number; cpu_percent?: number }
  variables: {
    env: string
    name: string
    description?: string
    type: 'string' | 'int' | 'bool' | 'enum' | 'port' | 'secret'
    default?: string | number | boolean
    options?: string[]
    required?: boolean
  }[]
}

const { data: servers, refresh, status } = await useFetch<ServerRow[]>('/api/admin/servers', { default: () => [] })
const { data: nodes } = await useFetch<{ id: string; name: string; online: boolean }[]>('/api/admin/nodes', {
  default: () => [],
  immediate: can('admin.nodes.read'),
})
const { data: users } = await useFetch<{ id: string; username: string; email: string }[]>('/api/admin/users', {
  default: () => [],
  immediate: can('admin.users.read'),
})
const { data: templates } = await useFetch<TemplateRow[]>('/api/admin/templates', {
  default: () => [],
  immediate: can('admin.templates.read'),
})
usePolling(refresh, 15_000)

const columns: TableColumn<ServerRow>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'status', header: 'Status' },
  { id: 'node', header: 'Node' },
  { id: 'address', header: 'Adresse' },
  { id: 'owner', header: 'Besitzer' },
  { id: 'resources', header: 'Ressourcen' },
  { id: 'actions', header: '' },
]

// --- create ------------------------------------------------------------------
const open = ref(false)
const saving = ref(false)
const error = ref('')
const fieldErrors = ref<Record<string, string>>({})

const form = reactive({
  name: '',
  ownerId: undefined as string | undefined,
  nodeId: undefined as string | undefined,
  allocationId: undefined as string | undefined,
  templateId: undefined as string | undefined,
  image: '',
  startup: '',
  memoryMb: 2048,
  diskMb: 10240,
  cpuPercent: 200,
  variables: {} as Record<string, string>,
  install: true,
})

const template = computed(() => templates.value.find((t) => t.id === form.templateId) ?? null)
const imageItems = computed(() =>
  template.value ? Object.entries(template.value.images).map(([label, value]) => ({ label, value })) : [],
)

watch(() => form.templateId, () => {
  const t = template.value
  if (!t) return
  form.image = Object.values(t.images)[0] ?? ''
  form.startup = ''
  if (t.resources.memory_mb) form.memoryMb = t.resources.memory_mb
  if (t.resources.disk_mb) form.diskMb = t.resources.disk_mb
  if (t.resources.cpu_percent) form.cpuPercent = t.resources.cpu_percent
  form.variables = Object.fromEntries(
    t.variables.map((v) => [v.env, v.type === 'bool' ? (v.default ? '1' : '0') : v.default === undefined ? '' : String(v.default)]),
  )
})

function openCreate() {
  Object.assign(form, {
    name: '', ownerId: undefined, nodeId: undefined, allocationId: undefined, templateId: undefined,
    image: '', startup: '', memoryMb: 2048, diskMb: 10240, cpuPercent: 200, variables: {}, install: true,
  })
  error.value = ''
  fieldErrors.value = {}
  open.value = true
}

const nodeItems = computed(() => nodes.value.map((n) => ({ label: `${n.name}${n.online ? '' : ' (offline)'}`, value: n.id })))
const userItems = computed(() => users.value.map((u) => ({ label: `${u.username} (${u.email})`, value: u.id })))
const templateItems = computed(() => templates.value.map((t) => ({ label: t.name, value: t.id })))

const nodeAllocations = ref<{ id: string; ip: string; port: number; alias: string | null; serverId: string | null }[]>([])
watch(() => form.nodeId, async (nodeId) => {
  form.allocationId = undefined
  nodeAllocations.value = []
  if (!nodeId) return
  try {
    const detail = await $fetch<{ allocations: typeof nodeAllocations.value }>(`/api/admin/nodes/${nodeId}`)
    if (form.nodeId === nodeId) nodeAllocations.value = detail.allocations
  } catch (err) {
    error.value = errorMessage(err)
  }
})
const allocationItems = computed(() =>
  nodeAllocations.value
    .filter((a) => !a.serverId)
    .map((a) => ({ label: `${a.ip}:${a.port}${a.alias ? ` (${a.alias})` : ''}`, value: a.id })),
)

const canSubmit = computed(() => form.name.trim() && form.ownerId && form.nodeId && form.allocationId && form.image.trim() && (form.templateId || form.startup.trim()))

async function submit() {
  saving.value = true
  error.value = ''
  fieldErrors.value = {}
  try {
    const res = await $fetch<{ id: string }>('/api/admin/servers', {
      method: 'POST',
      body: {
        name: form.name,
        ownerId: form.ownerId,
        nodeId: form.nodeId,
        allocationId: form.allocationId,
        templateId: form.templateId ?? null,
        image: form.image,
        startup: form.startup || undefined,
        variables: form.variables,
        memoryMb: form.memoryMb,
        diskMb: form.diskMb,
        cpuPercent: form.cpuPercent,
        install: form.install,
      },
    })
    open.value = false
    toast.add({ title: 'Server angelegt', color: 'success' })
    await navigateTo(`/servers/${res.id}`)
  } catch (err: any) {
    error.value = errorMessage(err)
    fieldErrors.value = err?.data?.data?.errors ?? {}
  } finally {
    saving.value = false
  }
}

// --- delete ------------------------------------------------------------------
const toDelete = ref<ServerRow | null>(null)
const forceDelete = ref(false)
async function confirmDelete() {
  if (!toDelete.value) return
  try {
    await $fetch(`/api/admin/servers/${toDelete.value.id}`, { method: 'DELETE', query: { force: String(forceDelete.value) } })
    toast.add({ title: 'Server gelöscht', color: 'success' })
    toDelete.value = null
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  }
}
</script>

<template>
  <UDashboardPanel id="servers">
    <template #header>
      <UDashboardNavbar title="Alle Server">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton v-if="can('admin.servers.write')" icon="i-lucide-plus" label="Server anlegen" :disabled="!nodes.length" @click="openCreate" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UTable :data="servers" :columns="columns" :loading="status === 'pending'">
        <template #name-cell="{ row }">
          <NuxtLink :to="`/servers/${row.original.id}`" class="font-medium text-highlighted hover:underline">{{ row.original.name }}</NuxtLink>
        </template>
        <template #status-cell="{ row }">
          <UBadge :color="serverStatus(row.original.status).color" variant="subtle">{{ serverStatus(row.original.status).label }}</UBadge>
        </template>
        <template #node-cell="{ row }">
          <NuxtLink :to="`/admin/nodes/${row.original.node.id}`" class="hover:underline">{{ row.original.node.name }}</NuxtLink>
        </template>
        <template #address-cell="{ row }">
          <span v-for="a in row.original.allocations" :key="a.id" class="block font-mono text-xs">{{ row.original.node.publicHost }}:{{ a.port }}</span>
        </template>
        <template #owner-cell="{ row }">{{ row.original.owner.username }}</template>
        <template #resources-cell="{ row }">
          <span class="text-xs text-muted">
            {{ formatMb(row.original.memoryMb) }} RAM · {{ formatMb(row.original.diskMb) }} Disk · {{ row.original.cpuPercent }} % CPU
          </span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end">
            <UButton
              v-if="can('admin.servers.delete')"
              icon="i-lucide-trash-2"
              color="neutral"
              variant="ghost"
              size="xs"
              aria-label="Server löschen"
              @click="toDelete = row.original; forceDelete = false"
            />
          </div>
        </template>
        <template #empty>
          <UEmpty icon="i-lucide-server" title="Noch keine Server" :description="nodes.length ? 'Lege den ersten Server an.' : 'Lege zuerst eine Node mit Allocations an.'" />
        </template>
      </UTable>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="open" title="Server anlegen" :ui="{ content: 'sm:max-w-3xl' }">
    <template #body>
      <form id="server-form" class="space-y-5" @submit.prevent="submit">
        <div class="grid sm:grid-cols-2 gap-4">
          <UFormField label="Name" required>
            <UInput v-model="form.name" class="w-full" autofocus maxlength="64" />
          </UFormField>
          <UFormField label="Besitzer" required>
            <USelectMenu v-model="form.ownerId" :items="userItems" value-key="value" placeholder="Benutzer wählen" class="w-full" />
          </UFormField>
          <UFormField label="Node" required>
            <USelect v-model="form.nodeId" :items="nodeItems" placeholder="Node wählen" class="w-full" />
          </UFormField>
          <UFormField label="Allocation" required :help="form.nodeId && !allocationItems.length ? 'Keine freie Allocation auf dieser Node.' : undefined">
            <USelect v-model="form.allocationId" :items="allocationItems" :disabled="!form.nodeId" placeholder="Port wählen" class="w-full" />
          </UFormField>
        </div>

        <USeparator label="Software" />
        <div class="grid sm:grid-cols-2 gap-4">
          <UFormField label="Template" help="Ohne Template gibst du Image und Startbefehl selbst an.">
            <USelectMenu v-model="form.templateId" :items="templateItems" value-key="value" placeholder="Kein Template" class="w-full" />
          </UFormField>
          <UFormField label="Docker-Image" required>
            <USelect v-if="imageItems.length" v-model="form.image" :items="imageItems" class="w-full" />
            <UInput v-else v-model="form.image" class="w-full font-mono" placeholder="ghcr.io/pterodactyl/yolks:java_21" />
          </UFormField>
        </div>
        <UFormField :label="template ? 'Startbefehl (optional, überschreibt Template)' : 'Startbefehl'" :required="!template">
          <UInput v-model="form.startup" class="w-full font-mono" :placeholder="template?.startup" />
        </UFormField>

        <template v-if="template?.variables.length">
          <USeparator label="Variablen" />
          <div class="grid sm:grid-cols-2 gap-4">
            <UFormField
              v-for="v in template.variables"
              :key="v.env"
              :label="v.name"
              :hint="v.env"
              :help="v.description"
              :error="fieldErrors[v.env]"
              :required="v.required"
            >
              <USelect v-if="v.type === 'enum'" v-model="form.variables[v.env]" :items="v.options ?? []" class="w-full" />
              <USwitch
                v-else-if="v.type === 'bool'"
                :model-value="form.variables[v.env] === '1' || form.variables[v.env] === 'true'"
                @update:model-value="(b: boolean) => (form.variables[v.env] = b ? '1' : '0')"
              />
              <UInput v-else v-model="form.variables[v.env]" :type="v.type === 'secret' ? 'password' : 'text'" class="w-full font-mono" />
            </UFormField>
          </div>
        </template>

        <USeparator label="Ressourcen" />
        <div class="grid grid-cols-3 gap-4">
          <UFormField label="RAM (MiB)">
            <UInputNumber v-model="form.memoryMb" :min="64" :step="512" class="w-full" />
          </UFormField>
          <UFormField label="Disk (MiB)">
            <UInputNumber v-model="form.diskMb" :min="128" :step="1024" class="w-full" />
          </UFormField>
          <UFormField label="CPU (%)" help="100 = 1 Kern">
            <UInputNumber v-model="form.cpuPercent" :min="0" :step="50" class="w-full" />
          </UFormField>
        </div>
        <UCheckbox v-if="template?.hasInstall" v-model="form.install" label="Installationsskript direkt ausführen" />
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      </form>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Abbrechen" @click="open = false" />
        <UButton type="submit" form="server-form" label="Anlegen" :loading="saving" :disabled="!canSubmit" />
      </div>
    </template>
  </UModal>

  <UModal
    :open="!!toDelete"
    title="Server löschen?"
    :description="`${toDelete?.name} wird mit allen Dateien auf der Node gelöscht.`"
    @update:open="(v: boolean) => { if (!v) toDelete = null }"
  >
    <template #body>
      <UCheckbox v-model="forceDelete" label="Auch löschen, wenn die Node nicht erreichbar ist (Dateien bleiben dann liegen)" />
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Abbrechen" @click="toDelete = null" />
        <UButton color="error" label="Löschen" @click="confirmDelete" />
      </div>
    </template>
  </UModal>
</template>
