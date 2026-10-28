<script setup lang="ts">
export interface DashboardServer {
  id: string
  name: string
  description: string | null
  status: string
  nodeName: string
  nodeOnline: boolean
  address: string | null
  color: string | null
  groupId: string | null
  isOwner: boolean
}

const props = defineProps<{
  server: DashboardServer
  groupColor?: string | null
  groups: { id: string; name: string }[]
  draggable: boolean
}>()

const emit = defineEmits<{
  color: [color: string | null]
  move: [groupId: string | null]
}>()

const status = computed(() => serverStatus(props.server.nodeOnline ? props.server.status : 'unknown'))
const accent = computed(() => props.server.color ?? props.groupColor ?? null)

const toast = useToast()
async function copyAddress() {
  if (!props.server.address) return
  await navigator.clipboard.writeText(props.server.address)
  toast.add({ title: 'Adresse kopiert', icon: 'i-lucide-check', color: 'success' })
}

const colorOpen = ref(false)
const color = ref<string | null>(props.server.color)
watch(color, (c) => {
  if (c !== props.server.color) emit('color', c)
  colorOpen.value = false
})

const moveItems = computed(() => [
  [{ label: 'Verschieben nach', type: 'label' as const }],
  [
    ...props.groups.map((g) => ({
      label: g.name,
      icon: g.id === props.server.groupId ? 'i-lucide-check' : undefined,
      onSelect: () => emit('move', g.id),
    })),
    { label: 'Ohne Gruppe', icon: props.server.groupId === null ? 'i-lucide-check' : undefined, onSelect: () => emit('move', null) },
  ],
])
</script>

<template>
  <div
    class="group relative rounded-lg border border-default bg-default hover:bg-elevated/50 transition-colors border-l-4"
    :class="accent ? COLOR_BORDER[accent] : 'border-l-default'"
    :data-server-id="server.id"
  >
    <NuxtLink :to="`/servers/${server.id}`" class="block p-3 pr-20">
      <div class="flex items-center gap-2 min-w-0">
        <UIcon v-if="draggable" name="i-lucide-grip-vertical" class="drag-handle size-4 shrink-0 text-dimmed cursor-grab" @click.prevent />
        <span class="font-medium text-highlighted truncate">{{ server.name }}</span>
      </div>
      <p v-if="server.description" class="text-xs text-muted truncate mt-0.5">{{ server.description }}</p>
      <div class="flex flex-wrap items-center gap-2 mt-2 text-xs">
        <UBadge :color="status.color" variant="subtle" size="sm" :icon="status.icon">{{ status.label }}</UBadge>
        <span class="text-muted">{{ server.nodeName }}</span>
        <span v-if="!server.nodeOnline" class="text-warning">Node offline</span>
      </div>
    </NuxtLink>

    <div class="absolute top-2 right-2 flex items-center gap-0.5">
      <UTooltip v-if="server.address" :text="server.address">
        <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" aria-label="Adresse kopieren" @click="copyAddress" />
      </UTooltip>
      <UPopover v-model:open="colorOpen">
        <UButton icon="i-lucide-palette" size="xs" color="neutral" variant="ghost" aria-label="Farbe wählen" />
        <template #content>
          <div class="p-3 w-60">
            <p class="text-xs text-muted mb-2">Farbe (nur für dich sichtbar)</p>
            <ColorSelect v-model="color" allow-none />
          </div>
        </template>
      </UPopover>
      <UDropdownMenu :items="moveItems">
        <UButton icon="i-lucide-folder-input" size="xs" color="neutral" variant="ghost" aria-label="In Gruppe verschieben" />
      </UDropdownMenu>
    </div>
  </div>
</template>
