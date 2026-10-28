<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

useHead({ title: 'Templates' })
const toast = useToast()
const { can } = useMe()

interface TemplateRow {
  id: string
  slug: string
  name: string
  description: string | null
  author: string | null
  source: { kind: string; ref?: string } | null
  images: Record<string, string>
  startup: string
  variables: { env: string; name: string; type: string }[]
  hasInstall: boolean
  serverCount: number
}
const { data: templates, refresh, status } = await useFetch<TemplateRow[]>('/api/admin/templates', { default: () => [] })

const columns: TableColumn<TemplateRow>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'source', header: 'Herkunft' },
  { accessorKey: 'images', header: 'Images' },
  { accessorKey: 'variables', header: 'Variablen' },
  { accessorKey: 'serverCount', header: 'Server' },
  actionsColumn<TemplateRow>(),
]

// --- import ---
const importOpen = ref(false)
const eggText = ref('')
const overwrite = ref(false)
const importing = ref(false)
const importResult = ref<{ name: string; warnings: string[]; replaced: boolean } | null>(null)
const importError = ref('')

function openImport() {
  eggText.value = ''
  overwrite.value = false
  importResult.value = null
  importError.value = ''
  importOpen.value = true
}

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (file.size > 2_000_000) {
    importError.value = 'Datei ist zu groß (max. 2 MB)'
    return
  }
  eggText.value = await file.text()
}

async function doImport() {
  importing.value = true
  importError.value = ''
  try {
    importResult.value = await $fetch<{ name: string; warnings: string[]; replaced: boolean }>('/api/admin/templates/import-egg', { method: 'POST', body: { egg: eggText.value, overwrite: overwrite.value } })
    await refresh()
  } catch (err) {
    importError.value = errorMessage(err)
  } finally {
    importing.value = false
  }
}

// --- delete ---
async function remove(t: TemplateRow) {
  try {
    await $fetch(`/api/admin/templates/${t.id}`, { method: 'DELETE' })
    toast.add({ title: 'Template gelöscht', color: 'success' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  }
}
</script>

<template>
  <UDashboardPanel id="templates">
    <template #header>
      <UDashboardNavbar title="Templates">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton v-if="can('admin.templates.write')" icon="i-lucide-file-up" label="Egg importieren" @click="openImport" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UTable :data="templates" :columns="columns" :loading="status === 'pending'">
        <template #name-cell="{ row }">
          <p class="font-medium text-highlighted">{{ row.original.name }}</p>
          <p class="text-xs text-muted line-clamp-1 max-w-md">{{ row.original.description }}</p>
        </template>
        <template #source-cell="{ row }">
          <UBadge v-if="row.original.source?.kind === 'egg'" label="Egg-Import" variant="subtle" color="neutral" />
          <span v-else class="text-muted">–</span>
        </template>
        <template #images-cell="{ row }">
          <div>
            <span v-for="(img, label) in row.original.images" :key="label" class="block text-xs">{{ label }}</span>
          </div>
        </template>
        <template #variables-cell="{ row }">{{ row.original.variables.length }}</template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end">
            <UButton
              v-if="can('admin.templates.write')"
              icon="i-lucide-trash-2"
              size="xs"
              color="neutral"
              variant="ghost"
              aria-label="Template löschen"
              :disabled="row.original.serverCount > 0"
              @click="remove(row.original)"
            />
          </div>
        </template>
        <template #empty>
          <UEmpty
            icon="i-lucide-package"
            title="Noch keine Templates"
            description="Importiere ein Egg aus Pelican oder Pterodactyl, zum Beispiel aus github.com/pelican-eggs."
          />
        </template>
      </UTable>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="importOpen" title="Egg importieren" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <div v-if="importResult" class="space-y-3">
        <UAlert
          color="success"
          variant="subtle"
          icon="i-lucide-check"
          :title="`${importResult.name} ${importResult.replaced ? 'aktualisiert' : 'importiert'}`"
        />
        <div v-if="importResult.warnings.length">
          <p class="text-sm font-medium text-highlighted mb-1">Hinweise zur Konvertierung</p>
          <ul class="text-sm text-muted list-disc pl-5 space-y-0.5">
            <li v-for="w in importResult.warnings" :key="w">{{ w }}</li>
          </ul>
        </div>
      </div>
      <form v-else id="egg-form" class="space-y-4" @submit.prevent="doImport">
        <UFormField label="Egg-Datei (JSON)">
          <input type="file" accept="application/json,.json" class="text-sm" @change="onFile">
        </UFormField>
        <UFormField label="Oder JSON einfügen">
          <UTextarea v-model="eggText" :rows="10" class="w-full font-mono text-xs" placeholder='{ "meta": { "version": "PTDL_v2" }, … }' />
        </UFormField>
        <UCheckbox v-model="overwrite" label="Vorhandenes Template mit gleichem Namen ersetzen" />
        <UAlert v-if="importError" color="error" variant="subtle" :title="importError" />
      </form>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <template v-if="importResult">
          <UButton label="Weiteres Egg" color="neutral" variant="ghost" @click="openImport" />
          <UButton label="Fertig" @click="importOpen = false" />
        </template>
        <template v-else>
          <UButton color="neutral" variant="ghost" label="Abbrechen" @click="importOpen = false" />
          <UButton type="submit" form="egg-form" label="Importieren" :loading="importing" :disabled="!eggText.trim()" />
        </template>
      </div>
    </template>
  </UModal>
</template>
