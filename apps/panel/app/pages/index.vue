<script setup lang="ts">
import Sortable from 'sortablejs'
import type { DashboardServer } from '~/components/ServerCard.vue'

useHead({ title: 'Meine Server' })
const toast = useToast()

interface Group {
  id: string
  name: string
  color: string
  sortOrder: number
  collapsed: boolean
}
interface ServerRow extends DashboardServer {
  sortOrder: number
}

const { data, refresh } = await useFetch<{ groups: Group[]; servers: ServerRow[] }>('/api/servers', {
  default: () => ({ groups: [], servers: [] }),
})
usePolling(refresh, 10_000)

// --- view options ----------------------------------------------------------
type SortMode = 'manual' | 'name' | 'status'
const sortMode = useCookie<SortMode>('server-sort', { default: () => 'manual' })
const search = ref('')
const sortItems = [
  { label: 'Eigene Reihenfolge', value: 'manual', icon: 'i-lucide-grip-vertical' },
  { label: 'Name', value: 'name', icon: 'i-lucide-arrow-down-a-z' },
  { label: 'Status', value: 'status', icon: 'i-lucide-activity' },
]
const STATUS_RANK: Record<string, number> = { running: 0, starting: 1, stopping: 2, installing: 3, offline: 4, install_failed: 5, suspended: 6 }

const dragEnabled = computed(() => sortMode.value === 'manual' && !search.value)

function sortServers(list: ServerRow[]) {
  const copy = [...list]
  if (sortMode.value === 'name') copy.sort((a, b) => a.name.localeCompare(b.name, 'de'))
  else if (sortMode.value === 'status') copy.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.name.localeCompare(b.name, 'de'))
  else copy.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'de'))
  return copy
}

interface Section {
  key: string
  group: Group | null
  servers: ServerRow[]
}

const sections = computed<Section[]>(() => {
  const q = search.value.trim().toLowerCase()
  const visible = data.value.servers.filter((s) => !q || s.name.toLowerCase().includes(q) || s.address?.includes(q))
  const groupIds = new Set(data.value.groups.map((g) => g.id))
  const result: Section[] = data.value.groups.map((g) => ({
    key: g.id,
    group: g,
    servers: sortServers(visible.filter((s) => s.groupId === g.id)),
  }))
  result.push({
    key: 'ungrouped',
    group: null,
    servers: sortServers(visible.filter((s) => !s.groupId || !groupIds.has(s.groupId))),
  })
  return result
})

const totalRunning = computed(() => data.value.servers.filter((s) => s.status === 'running').length)
const groupOptions = computed(() => data.value.groups.map((g) => ({ id: g.id, name: g.name })))

// --- persistence -------------------------------------------------------------
async function saveLayout() {
  const groups = data.value.groups.map((g) => g.id)
  const servers = sections.value.flatMap((sec) => sec.servers.map((s) => ({ serverId: s.id, groupId: sec.group?.id ?? null })))
  try {
    await $fetch('/api/layout', { method: 'PUT', body: { groups, servers } })
  } catch (err) {
    toast.add({ title: 'Reihenfolge nicht gespeichert', description: errorMessage(err), color: 'error' })
    await refresh()
  }
}

function applyOrder(order: { serverId: string; groupId: string | null }[]) {
  const pos = new Map<string, number>()
  for (const item of order) {
    const key = item.groupId ?? ''
    const n = pos.get(key) ?? 0
    pos.set(key, n + 1)
    const s = data.value.servers.find((x) => x.id === item.serverId)
    if (s) {
      s.groupId = item.groupId
      s.sortOrder = n
    }
  }
}

async function moveServer(server: ServerRow, groupId: string | null) {
  // Append to the end of the target group.
  const order = sections.value.flatMap((sec) =>
    sec.servers.filter((s) => s.id !== server.id).map((s) => ({ serverId: s.id, groupId: sec.group?.id ?? null })),
  )
  order.push({ serverId: server.id, groupId })
  applyOrder(order)
  if (sortMode.value !== 'manual') sortMode.value = 'manual'
  await saveLayout()
}

async function setServerColor(server: ServerRow, color: string | null) {
  server.color = color
  try {
    await $fetch(`/api/servers/${server.id}/prefs`, { method: 'PATCH', body: { color } })
  } catch (err) {
    toast.add({ title: 'Farbe nicht gespeichert', description: errorMessage(err), color: 'error' })
  }
}

// --- drag & drop ---------------------------------------------------------------
// Sortable moves DOM nodes itself; we read the resulting order, put the node
// back and let Vue re-render from state, so DOM and state never diverge.
const listEls = new Map<string, HTMLElement>()
const sortables: Sortable[] = []
const groupsEl = ref<HTMLElement | null>(null)

function setListEl(key: string, el: unknown) {
  if (el instanceof HTMLElement) listEls.set(key, el)
  else listEls.delete(key)
}

function readOrder() {
  return sections.value.flatMap((sec) => {
    const el = listEls.get(sec.key)
    if (!el) return []
    return [...el.querySelectorAll<HTMLElement>(':scope > [data-server-id]')].map((n) => ({
      serverId: n.dataset.serverId!,
      groupId: sec.group?.id ?? null,
    }))
  })
}

function setupSortables() {
  sortables.splice(0).forEach((s) => s.destroy())
  if (!dragEnabled.value) return
  for (const el of listEls.values()) {
    sortables.push(
      Sortable.create(el, {
        group: 'servers',
        handle: '.drag-handle',
        animation: 150,
        ghostClass: 'opacity-40',
        onEnd(evt) {
          const order = readOrder()
          // Revert the DOM move; Vue renders the new order from state.
          evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex!] ?? null)
          applyOrder(order)
          saveLayout()
        },
      }),
    )
  }
  if (groupsEl.value) {
    sortables.push(
      Sortable.create(groupsEl.value, {
        handle: '.group-handle',
        draggable: '[data-group-id]',
        animation: 150,
        onEnd(evt) {
          const ids = [...groupsEl.value!.querySelectorAll<HTMLElement>(':scope > [data-group-id]')].map((n) => n.dataset.groupId!)
          evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex!] ?? null)
          data.value.groups.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
          saveLayout()
        },
      }),
    )
  }
}

onMounted(() => nextTick(setupSortables))
watch([dragEnabled, () => data.value.groups.length, () => sections.value.map((s) => s.group?.collapsed).join()], () => nextTick(setupSortables))
onBeforeUnmount(() => sortables.forEach((s) => s.destroy()))

// --- groups --------------------------------------------------------------------
const groupModal = ref(false)
const editingGroup = ref<Group | null>(null)
const groupForm = reactive({ name: '', color: 'neutral' as string | null })
const savingGroup = ref(false)

function openGroup(group: Group | null) {
  editingGroup.value = group
  groupForm.name = group?.name ?? ''
  groupForm.color = group?.color ?? 'blue'
  groupModal.value = true
}

async function saveGroup() {
  if (!groupForm.name.trim()) return
  savingGroup.value = true
  try {
    const body = { name: groupForm.name.trim(), color: groupForm.color ?? 'neutral' }
    if (editingGroup.value) await $fetch(`/api/groups/${editingGroup.value.id}`, { method: 'PATCH', body })
    else await $fetch('/api/groups', { method: 'POST', body })
    groupModal.value = false
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  } finally {
    savingGroup.value = false
  }
}

async function toggleCollapsed(group: Group) {
  group.collapsed = !group.collapsed
  await $fetch(`/api/groups/${group.id}`, { method: 'PATCH', body: { collapsed: group.collapsed } }).catch(() => {})
}

async function deleteGroup(group: Group) {
  try {
    await $fetch(`/api/groups/${group.id}`, { method: 'DELETE' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  }
}

function groupMenu(group: Group) {
  return [[
    { label: 'Bearbeiten', icon: 'i-lucide-pencil', onSelect: () => openGroup(group) },
    { label: 'Löschen', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => deleteGroup(group) },
  ]]
}
</script>

<template>
  <UDashboardPanel id="overview">
    <template #header>
      <UDashboardNavbar title="Meine Server">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton icon="i-lucide-folder-plus" label="Neue Gruppe" color="neutral" variant="outline" @click="openGroup(null)" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <template #left>
          <UInput v-model="search" icon="i-lucide-search" placeholder="Suchen…" class="w-56" />
          <span class="text-sm text-muted hidden sm:inline">{{ totalRunning }} von {{ data.servers.length }} laufen</span>
        </template>
        <template #right>
          <USelect v-model="sortMode" :items="sortItems" class="w-48" />
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <UEmpty
        v-if="!data.servers.length"
        icon="i-lucide-server"
        title="Noch keine Server"
        description="Sobald dir ein Server zugewiesen wird, erscheint er hier."
      />

      <div v-else ref="groupsEl" class="space-y-6">
        <section
          v-for="sec in sections"
          :key="sec.key"
          :data-group-id="sec.group?.id"
          class="space-y-2"
        >
          <div v-if="sec.group || data.groups.length" class="flex items-center gap-2">
            <UIcon v-if="sec.group && dragEnabled" name="i-lucide-grip-vertical" class="group-handle size-4 text-dimmed cursor-grab" />
            <button
              v-if="sec.group"
              type="button"
              class="flex items-center gap-2 min-w-0"
              :aria-expanded="!sec.group.collapsed"
              @click="toggleCollapsed(sec.group)"
            >
              <UIcon :name="sec.group.collapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" class="size-4 text-muted" />
              <span class="size-2.5 rounded-full shrink-0" :class="COLOR_DOT[sec.group.color]" />
              <h2 class="font-semibold text-highlighted truncate">{{ sec.group.name }}</h2>
            </button>
            <h2 v-else class="font-semibold text-muted">Ohne Gruppe</h2>
            <UBadge :label="String(sec.servers.length)" color="neutral" variant="subtle" size="sm" />
            <UDropdownMenu v-if="sec.group" :items="groupMenu(sec.group)">
              <UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" aria-label="Gruppenaktionen" />
            </UDropdownMenu>
          </div>

          <div
            v-show="!sec.group?.collapsed"
            :ref="(el: unknown) => setListEl(sec.key, el)"
            class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 min-h-12 rounded-lg"
            :class="dragEnabled && !sec.servers.length ? 'border border-dashed border-default p-2' : ''"
          >
            <ServerCard
              v-for="s in sec.servers"
              :key="s.id"
              :server="s"
              :group-color="sec.group?.color"
              :groups="groupOptions"
              :draggable="dragEnabled"
              @color="(c) => setServerColor(s, c)"
              @move="(g) => moveServer(s, g)"
            />
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="groupModal" :title="editingGroup ? 'Gruppe bearbeiten' : 'Neue Gruppe'">
    <template #body>
      <form id="group-form" class="space-y-4" @submit.prevent="saveGroup">
        <UFormField label="Name" required>
          <UInput v-model="groupForm.name" class="w-full" maxlength="48" autofocus />
        </UFormField>
        <UFormField label="Farbe">
          <ColorSelect v-model="groupForm.color" />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Abbrechen" @click="groupModal = false" />
        <UButton type="submit" form="group-form" label="Speichern" :loading="savingGroup" :disabled="!groupForm.name.trim()" />
      </div>
    </template>
  </UModal>
</template>
