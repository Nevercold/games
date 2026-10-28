<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent, TableColumn } from '@nuxt/ui'

useHead({ title: 'Nodes' })

const { data: nodes, refresh, status } = await useFetch('/api/admin/nodes', { default: () => [] })
type Node = (typeof nodes.value)[number]

// Online state changes without user action, so poll while the page is open.
usePolling(refresh, 10_000)

const columns: TableColumn<Node>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'online', header: 'Status' },
  { accessorKey: 'publicHost', header: 'Adresse' },
  { accessorKey: 'serverCount', header: 'Server' },
  { accessorKey: 'lastSeenAt', header: 'Zuletzt gesehen' },
]

const schema = z.object({
  name: z.string().trim().min(1, 'Pflichtfeld').max(64),
  publicHost: z.string().trim().min(1, 'Pflichtfeld').max(255),
  description: z.string().max(500).optional(),
  memoryMb: z.number().int().min(0),
  diskMb: z.number().int().min(0),
})
type Schema = z.output<typeof schema>

const open = ref(false)
const createdToken = ref<string | null>(null)
const saving = ref(false)
const error = ref('')
const state = reactive<Schema>({ name: '', publicHost: '', description: '', memoryMb: 0, diskMb: 0 })

function openCreate() {
  Object.assign(state, { name: '', publicHost: '', description: '', memoryMb: 0, diskMb: 0 })
  createdToken.value = null
  error.value = ''
  open.value = true
}

async function onSubmit(event: FormSubmitEvent<Schema>) {
  saving.value = true
  error.value = ''
  try {
    const res = await $fetch('/api/admin/nodes', { method: 'POST', body: event.data })
    createdToken.value = res.token
    await refresh()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="nodes">
    <template #header>
      <UDashboardNavbar title="Nodes">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton icon="i-lucide-plus" label="Node hinzufügen" @click="openCreate" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UTable
        :data="nodes"
        :columns="columns"
        :loading="status === 'pending'"
      >
        <template #name-cell="{ row }">
          <NuxtLink :to="`/admin/nodes/${row.original.id}`" class="font-medium text-highlighted hover:underline">
            {{ row.original.name }}
          </NuxtLink>
        </template>
        <template #online-cell="{ row }">
          <UBadge :color="row.original.online ? 'success' : 'neutral'" variant="subtle">
            {{ row.original.online ? 'online' : 'offline' }}
          </UBadge>
        </template>
        <template #lastSeenAt-cell="{ row }">
          {{ row.original.online ? 'jetzt' : formatRelative(row.original.lastSeenAt) }}
        </template>
        <template #empty>
          <UEmpty icon="i-lucide-network" title="Noch keine Nodes" description="Füge eine Node hinzu und starte dort den Daemon." />
        </template>
      </UTable>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="open" :title="createdToken ? 'Node angelegt' : 'Node hinzufügen'">
    <template #body>
      <NodeTokenDisplay v-if="createdToken" :token="createdToken" />
      <UForm v-else id="node-form" :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
        <UFormField label="Name" name="name">
          <UInput v-model="state.name" class="w-full" autofocus />
        </UFormField>
        <UFormField label="Öffentliche Adresse" name="publicHost" help="IP oder Hostname, über den Spieler die Server erreichen.">
          <UInput v-model="state.publicHost" placeholder="node1.example.com" class="w-full" />
        </UFormField>
        <UFormField label="Beschreibung" name="description">
          <UTextarea v-model="state.description" class="w-full" :rows="2" />
        </UFormField>
        <div class="grid grid-cols-2 gap-4">
          <UFormField label="RAM (MiB)" name="memoryMb" help="0 = unbegrenzt">
            <UInputNumber v-model="state.memoryMb" :min="0" :step="1024" class="w-full" />
          </UFormField>
          <UFormField label="Disk (MiB)" name="diskMb" help="0 = unbegrenzt">
            <UInputNumber v-model="state.diskMb" :min="0" :step="1024" class="w-full" />
          </UFormField>
        </div>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      </UForm>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton v-if="createdToken" label="Fertig" @click="open = false" />
        <template v-else>
          <UButton color="neutral" variant="ghost" label="Abbrechen" @click="open = false" />
          <UButton type="submit" form="node-form" label="Anlegen" :loading="saving" />
        </template>
      </div>
    </template>
  </UModal>
</template>
