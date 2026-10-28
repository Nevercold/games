<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

const route = useRoute()
const id = route.params.id as string
const { data: server } = await useServerDetail(id)
const toast = useToast()

const can = (p: string) => server.value?.permissions.includes(p) ?? false
if (!can('file.read')) throw createError({ statusCode: 404, statusMessage: 'Seite nicht gefunden', fatal: true })

interface Entry {
  name: string
  size: number
  mode: number
  modified: number
  isDir: boolean
  isSymlink: boolean
}

// --- navigation ----------------------------------------------------------------
const dir = computed(() => {
  const p = typeof route.query.path === 'string' ? route.query.path : '/'
  return '/' + p.split('/').filter((s) => s && s !== '.' && s !== '..').join('/')
})
const join = (a: string, b: string) => (a === '/' ? '' : a) + '/' + b
const crumbs = computed(() => {
  const parts = dir.value.split('/').filter(Boolean)
  return [
    { label: 'Server', icon: 'i-lucide-house', to: { query: { path: '/' } } },
    ...parts.map((p, i) => ({ label: p, to: { query: { path: '/' + parts.slice(0, i + 1).join('/') } } })),
  ]
})
const go = (path: string) => navigateTo({ query: { path } })

const { data: entries, refresh, status, error } = await useFetch<Entry[]>(`/api/servers/${id}/files/list`, {
  query: { path: dir },
  default: () => [],
  watch: [dir],
})

const filter = ref('')
const visible = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return q ? entries.value.filter((e) => e.name.toLowerCase().includes(q)) : entries.value
})

// --- selection ---------------------------------------------------------------------
const selected = ref(new Set<string>())
watch(dir, () => selected.value.clear())
const toggle = (name: string, on: boolean) => {
  const s = new Set(selected.value)
  if (on) s.add(name)
  else s.delete(name)
  selected.value = s
}
const allSelected = computed(() => visible.value.length > 0 && visible.value.every((e) => selected.value.has(e.name)))
const toggleAll = (on: boolean) => (selected.value = on ? new Set(visible.value.map((e) => e.name)) : new Set())

const columns: TableColumn<Entry>[] = [
  { id: 'select', header: () => h(resolveComponent('UCheckbox'), { modelValue: allSelected.value, 'onUpdate:modelValue': (v: boolean) => toggleAll(v), 'aria-label': 'Alle auswählen' }) },
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'size', header: 'Größe' },
  { accessorKey: 'modified', header: 'Geändert' },
  actionsColumn<Entry>(),
]

const ARCHIVE = /\.(zip|tar|tar\.gz|tgz)$/i
const fileIcon = (e: Entry) =>
  e.isDir ? 'i-lucide-folder' : e.isSymlink ? 'i-lucide-link' : ARCHIVE.test(e.name) ? 'i-lucide-file-archive' : 'i-lucide-file'

async function call(action: string, body: object, success?: string) {
  try {
    const res = await $fetch<Record<string, unknown>>(`/api/servers/${id}/files/${action}`, { method: 'POST', body })
    if (success) toast.add({ title: success, color: 'success' })
    await refresh()
    return res
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
    return null
  }
}

// --- open / download -----------------------------------------------------------
function open(e: Entry) {
  if (e.isDir) return go(join(dir.value, e.name))
  if (can('file.read-content')) openEditor(join(dir.value, e.name))
}
const downloadUrl = (e: Entry) => `/api/servers/${id}/files/download?path=${encodeURIComponent(join(dir.value, e.name))}`

// --- editor --------------------------------------------------------------------------
const editor = reactive({ open: false, path: '', content: '', original: '', loading: false, saving: false, create: false })
const dirty = computed(() => editor.content !== editor.original)

async function openEditor(path: string, create = false) {
  Object.assign(editor, { open: true, path, content: '', original: '', loading: !create, create })
  if (create) return
  try {
    const res = await $fetch<{ content: string; binary: boolean }>(`/api/servers/${id}/files/content`, { query: { path } })
    if (res.binary) {
      editor.open = false
      toast.add({ title: 'Binärdatei', description: 'Diese Datei kann nicht im Editor geöffnet werden. Lade sie herunter.', color: 'warning' })
      return
    }
    editor.content = editor.original = res.content
  } catch (err) {
    editor.open = false
    toast.add({ title: 'Datei nicht geöffnet', description: errorMessage(err), color: 'error' })
  } finally {
    editor.loading = false
  }
}

async function saveEditor() {
  if (!editor.path || editor.saving) return
  if (!can(editor.create ? 'file.create' : 'file.update')) return
  editor.saving = true
  try {
    await $fetch(`/api/servers/${id}/files/content`, { method: 'PUT', body: { path: editor.path, content: editor.content, create: editor.create } })
    editor.original = editor.content
    editor.create = false
    toast.add({ title: 'Gespeichert', icon: 'i-lucide-check', color: 'success' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Speichern fehlgeschlagen', description: errorMessage(err), color: 'error' })
  } finally {
    editor.saving = false
  }
}

function closeEditor() {
  if (dirty.value && !confirmDiscard.value) {
    confirmDiscard.value = true
    return
  }
  confirmDiscard.value = false
  editor.open = false
}
const confirmDiscard = ref(false)

// --- name prompts (new file, new folder, rename) ----------------------------------
const prompt = reactive({ open: false, mode: 'folder' as 'folder' | 'file' | 'rename', value: '', target: '' })
function askName(mode: 'folder' | 'file' | 'rename', e?: Entry) {
  Object.assign(prompt, { open: true, mode, value: e?.name ?? '', target: e?.name ?? '' })
}
async function submitPrompt() {
  const name = prompt.value.trim()
  if (!name || name.includes('/')) return
  prompt.open = false
  if (prompt.mode === 'folder') await call('mkdir', { path: join(dir.value, name) }, 'Ordner angelegt')
  else if (prompt.mode === 'file') openEditor(join(dir.value, name), true)
  else if (name !== prompt.target) await call('rename', { from: join(dir.value, prompt.target), to: join(dir.value, name) }, 'Umbenannt')
}

// --- delete / archives ------------------------------------------------------------
const toDelete = ref<string[]>([])
async function confirmDelete() {
  const paths = toDelete.value.map((n) => join(dir.value, n))
  toDelete.value = []
  await call('delete', { paths }, paths.length > 1 ? `${paths.length} Einträge gelöscht` : 'Gelöscht')
  selected.value = new Set()
}
async function compress(names: string[]) {
  const res = await call('compress', { root: dir.value, paths: names }, 'Archiv erstellt')
  if (res) selected.value = new Set()
}
const decompress = (e: Entry) => call('decompress', { root: dir.value, archive: join(dir.value, e.name) }, 'Archiv entpackt')

function rowMenu(e: Entry) {
  const items = []
  if (!e.isDir && can('file.read-content')) {
    items.push({ label: 'Bearbeiten', icon: 'i-lucide-file-pen', onSelect: () => openEditor(join(dir.value, e.name)) })
    items.push({ label: 'Herunterladen', icon: 'i-lucide-download', onSelect: () => { window.location.href = downloadUrl(e) } })
  }
  if (can('file.update')) items.push({ label: 'Umbenennen', icon: 'i-lucide-text-cursor-input', onSelect: () => askName('rename', e) })
  if (can('file.archive')) {
    if (!e.isDir && ARCHIVE.test(e.name)) items.push({ label: 'Entpacken', icon: 'i-lucide-package-open', onSelect: () => decompress(e) })
    items.push({ label: 'Archivieren', icon: 'i-lucide-package', onSelect: () => compress([e.name]) })
  }
  const groups: object[][] = [items]
  if (can('file.delete')) groups.push([{ label: 'Löschen', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => (toDelete.value = [e.name]) }])
  return groups
}

// --- upload -------------------------------------------------------------------------
interface UploadItem { name: string; progress: number; error?: string; done?: boolean }
const uploads = ref<UploadItem[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)

function uploadOne(file: File, item: UploadItem) {
  return new Promise<void>((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/servers/${id}/files/upload?path=${encodeURIComponent(join(dir.value, file.name))}`)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) item.progress = Math.round((ev.loaded / ev.total) * 100)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        item.progress = 100
        item.done = true
      } else {
        try {
          item.error = JSON.parse(xhr.responseText).statusMessage
        } catch {
          item.error = `HTTP ${xhr.status}`
        }
      }
      resolve()
    }
    xhr.onerror = () => {
      item.error = 'Verbindung abgebrochen'
      resolve()
    }
    xhr.send(file)
  })
}

async function uploadFiles(files: FileList | File[] | null) {
  if (!files?.length || !can('file.create')) return
  const list = [...files]
  const items = list.map((f) => reactive<UploadItem>({ name: f.name, progress: 0 }))
  uploads.value = [...uploads.value.filter((u) => !u.done), ...items]
  for (const [i, f] of list.entries()) await uploadOne(f, items[i]!)
  await refresh()
  const failed = items.filter((u) => u.error).length
  toast.add(failed
    ? { title: `${failed} Upload(s) fehlgeschlagen`, color: 'error' }
    : { title: `${items.length} Datei(en) hochgeladen`, color: 'success' })
  setTimeout(() => (uploads.value = uploads.value.filter((u) => !u.done)), 3000)
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  uploadFiles(e.dataTransfer?.files ?? null)
}
</script>

<template>
  <div
    class="space-y-3 relative"
    @dragover.prevent="dragOver = can('file.create')"
    @dragleave.self="dragOver = false"
    @drop.prevent="onDrop"
  >
    <div class="flex flex-wrap items-center gap-2">
      <UBreadcrumb :items="crumbs" class="min-w-0 flex-1" />
      <UInput v-model="filter" icon="i-lucide-search" placeholder="Filtern…" size="sm" class="w-40" />
      <template v-if="selected.size">
        <UButton v-if="can('file.archive')" size="sm" color="neutral" variant="outline" icon="i-lucide-package" :label="`${selected.size} archivieren`" @click="compress([...selected])" />
        <UButton v-if="can('file.delete')" size="sm" color="error" variant="outline" icon="i-lucide-trash-2" :label="`${selected.size} löschen`" @click="toDelete = [...selected]" />
      </template>
      <UButton v-if="can('file.create')" size="sm" color="neutral" variant="outline" icon="i-lucide-folder-plus" label="Ordner" @click="askName('folder')" />
      <UButton v-if="can('file.create')" size="sm" color="neutral" variant="outline" icon="i-lucide-file-plus" label="Datei" @click="askName('file')" />
      <UButton v-if="can('file.create')" size="sm" icon="i-lucide-upload" label="Hochladen" @click="fileInput?.click()" />
      <input ref="fileInput" type="file" multiple class="hidden" @change="uploadFiles(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''">
    </div>

    <div v-if="uploads.length" class="space-y-1">
      <div v-for="u in uploads" :key="u.name" class="flex items-center gap-3 text-sm">
        <span class="truncate w-56">{{ u.name }}</span>
        <UProgress :model-value="u.progress" size="xs" class="flex-1" :color="u.error ? 'error' : u.done ? 'success' : 'primary'" />
        <span class="w-40 text-xs" :class="u.error ? 'text-error' : 'text-muted'">{{ u.error ?? `${u.progress} %` }}</span>
      </div>
    </div>

    <UAlert v-if="error" class="shrink-0" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="errorMessage(error, 'Verzeichnis nicht lesbar')" />

    <UTable :data="visible" :columns="columns" :loading="status === 'pending'">
      <template #select-cell="{ row }">
        <UCheckbox :model-value="selected.has(row.original.name)" :aria-label="`${row.original.name} auswählen`" @update:model-value="(v: boolean | 'indeterminate') => toggle(row.original.name, v === true)" />
      </template>
      <template #name-cell="{ row }">
        <button type="button" class="flex items-center gap-2 min-w-0 text-left hover:underline" @click="open(row.original)">
          <UIcon :name="fileIcon(row.original)" class="size-4 shrink-0" :class="row.original.isDir ? 'text-primary' : 'text-muted'" />
          <span class="truncate text-highlighted">{{ row.original.name }}</span>
        </button>
      </template>
      <template #size-cell="{ row }">
        <span class="tabular-nums text-muted">{{ row.original.isDir ? '–' : formatBytes(row.original.size) }}</span>
      </template>
      <template #modified-cell="{ row }">
        <span class="text-muted">{{ new Date(row.original.modified * 1000).toLocaleString('de-DE') }}</span>
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end">
          <UDropdownMenu :items="rowMenu(row.original)" :content="{ align: 'end' }">
            <UButton icon="i-lucide-ellipsis-vertical" size="xs" color="neutral" variant="ghost" :aria-label="`Aktionen für ${row.original.name}`" />
          </UDropdownMenu>
        </div>
      </template>
      <template #empty>
        <UEmpty icon="i-lucide-folder-open" title="Leerer Ordner" :description="can('file.create') ? 'Ziehe Dateien hierher, um sie hochzuladen.' : undefined" />
      </template>
    </UTable>

    <p v-if="server?.sftp" class="text-xs text-muted">
      Große Dateien und viele Dateien auf einmal gehen schneller per SFTP:
      <span class="font-mono">sftp://{{ server.sftp.username }}@{{ server.sftp.host }}:{{ server.sftp.port }}</span>
    </p>

    <div
      v-if="dragOver"
      class="absolute inset-0 rounded-lg border-2 border-dashed border-primary bg-primary/5 flex items-center justify-center pointer-events-none"
    >
      <p class="font-medium text-primary">Dateien hier ablegen, um sie nach {{ dir }} hochzuladen</p>
    </div>
  </div>

  <!-- Editor -->
  <UModal
    :open="editor.open"
    fullscreen
    :dismissible="false"
    :title="editor.path"
    :ui="{ body: 'flex-1 min-h-0 flex flex-col p-2 sm:p-3' }"
    @update:open="(v: boolean) => { if (!v) closeEditor() }"
  >
    <template #title>
      <span class="font-mono text-sm">{{ editor.path }}<span v-if="dirty" class="text-warning" aria-label="ungespeichert"> •</span></span>
    </template>
    <template #actions>
      <UButton
        v-if="can(editor.create ? 'file.create' : 'file.update')"
        icon="i-lucide-save"
        label="Speichern"
        size="sm"
        :loading="editor.saving"
        :disabled="!dirty && !editor.create"
        @click="saveEditor"
      />
    </template>
    <template #body>
      <div v-if="editor.loading" class="flex-1 flex items-center justify-center text-muted">Lädt…</div>
      <CodeEditor
        v-else
        v-model="editor.content"
        :filename="editor.path"
        :readonly="!can(editor.create ? 'file.create' : 'file.update')"
        class="flex-1"
        @save="saveEditor"
      />
    </template>
  </UModal>

  <UModal v-model:open="confirmDiscard" title="Änderungen verwerfen?" description="Die Datei hat ungespeicherte Änderungen.">
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Weiter bearbeiten" @click="confirmDiscard = false" />
        <UButton color="error" label="Verwerfen" @click="closeEditor" />
      </div>
    </template>
  </UModal>

  <UModal v-model:open="prompt.open" :title="prompt.mode === 'folder' ? 'Neuer Ordner' : prompt.mode === 'file' ? 'Neue Datei' : 'Umbenennen'">
    <template #body>
      <form id="name-form" @submit.prevent="submitPrompt">
        <UFormField label="Name" :error="prompt.value.includes('/') ? 'Ohne Schrägstrich' : undefined">
          <UInput v-model="prompt.value" class="w-full font-mono" autofocus />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Abbrechen" @click="prompt.open = false" />
        <UButton type="submit" form="name-form" label="OK" :disabled="!prompt.value.trim() || prompt.value.includes('/')" />
      </div>
    </template>
  </UModal>

  <UModal
    :open="toDelete.length > 0"
    title="Löschen?"
    :description="toDelete.length === 1 ? `${toDelete[0]} wird endgültig gelöscht.` : `${toDelete.length} Einträge werden endgültig gelöscht.`"
    @update:open="(v: boolean) => { if (!v) toDelete = [] }"
  >
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Abbrechen" @click="toDelete = []" />
        <UButton color="error" label="Löschen" @click="confirmDelete" />
      </div>
    </template>
  </UModal>
</template>
