<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

const id = useRoute().params.id as string
const { data: server } = await useServerDetail(id)
const toast = useToast()

const can = (p: string) => server.value?.permissions.includes(p) ?? false
if (!can('backup.read')) throw createError({ statusCode: 404, statusMessage: 'Seite nicht gefunden', fatal: true })

interface Backup {
  id: string
  name: string
  status: 'pending' | 'completed' | 'failed'
  sizeBytes: number
  sha256: string | null
  locked: boolean
  restoring: boolean
  error: string | null
  createdAt: string
  completedAt: string | null
}
interface BackupList {
  backups: Backup[]
  limit: number
  target: { id: string; name: string; type: string } | null
  serverTargetId: string | null
  serverStatus: string
  canConfigure: boolean
  targets: { id: string; name: string; type: string; isDefault: boolean }[]
}
const { data, refresh } = await useFetch<BackupList>(`/api/servers/${id}/backups`)

const busy = computed(() => data.value?.backups.some((b) => b.status === 'pending' || b.restoring) ?? false)
usePolling(() => busy.value && refresh(), 2000)
// Toast once a running job finished.
watch(
  () => data.value?.backups.map((b) => `${b.id}:${b.status}:${b.restoring}`).join(),
  (now, before) => {
    if (!before || !now) return
    for (const b of data.value!.backups) {
      if (before.includes(`${b.id}:pending`) && b.status !== 'pending') {
        toast.add({ title: b.status === 'completed' ? 'Backup fertig' : 'Backup fehlgeschlagen', description: b.error ?? b.name, color: b.status === 'completed' ? 'success' : 'error' })
      }
      if (before.includes(`${b.id}:completed:true`) && !b.restoring) {
        toast.add({ title: 'Wiederherstellung beendet', description: 'Details stehen in der Konsole.', color: 'info' })
      }
    }
  },
)

const counted = computed(() => data.value?.backups.filter((b) => b.status !== 'failed').length ?? 0)
const typeLabel: Record<string, string> = { local: 'Lokal', s3: 'S3', sftp: 'SFTP' }

const columns: TableColumn<Backup>[] = [
  { accessorKey: 'name', header: 'Backup' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'sizeBytes', header: 'Größe' },
  actionsColumn<Backup>(),
]

// --- create --------------------------------------------------------------------
const createOpen = ref(false)
const createForm = reactive({ name: '', ignore: '' })
const creating = ref(false)
async function createBackup() {
  creating.value = true
  try {
    await $fetch(`/api/servers/${id}/backups`, { method: 'POST', body: { name: createForm.name || undefined, ignore: createForm.ignore || undefined } })
    createOpen.value = false
    createForm.name = ''
    await refresh()
  } catch (err) {
    toast.add({ title: 'Backup nicht gestartet', description: errorMessage(err), color: 'error' })
  } finally {
    creating.value = false
  }
}

// --- restore -------------------------------------------------------------------
const restoreTarget = ref<Backup | null>(null)
const truncate = ref(false)
const restoring = ref(false)
const serverOffline = computed(() => ['offline', 'install_failed'].includes(server.value?.status ?? ''))
async function restore() {
  if (!restoreTarget.value) return
  restoring.value = true
  try {
    await $fetch(`/api/servers/${id}/backups/${restoreTarget.value.id}/restore`, { method: 'POST', body: { truncate: truncate.value } })
    toast.add({ title: 'Wiederherstellung gestartet', color: 'info' })
    restoreTarget.value = null
    await refresh()
  } catch (err) {
    toast.add({ title: 'Wiederherstellung nicht gestartet', description: errorMessage(err), color: 'error' })
  } finally {
    restoring.value = false
  }
}

// --- lock / delete -------------------------------------------------------------
async function toggleLock(b: Backup) {
  try {
    await $fetch(`/api/servers/${id}/backups/${b.id}`, { method: 'PATCH', body: { locked: !b.locked } })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  }
}
const deleteTarget = ref<Backup | null>(null)
const deleting = ref(false)
async function remove() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await $fetch(`/api/servers/${id}/backups/${deleteTarget.value.id}`, { method: 'DELETE' })
    deleteTarget.value = null
    await refresh()
  } catch (err) {
    toast.add({ title: 'Nicht gelöscht', description: errorMessage(err), color: 'error' })
  } finally {
    deleting.value = false
  }
}

// --- admin settings ------------------------------------------------------------
const settings = reactive({ backupLimit: data.value?.limit ?? 0, backupTargetId: data.value?.serverTargetId ?? null as string | null })
const targetItems = computed(() => [
  { label: 'Standardziel', value: null },
  ...(data.value?.targets ?? []).map((t) => ({ label: `${t.name} (${typeLabel[t.type] ?? t.type})`, value: t.id })),
])
const savingSettings = ref(false)
async function saveSettings() {
  savingSettings.value = true
  try {
    await $fetch(`/api/servers/${id}/backups/settings`, { method: 'PUT', body: settings })
    toast.add({ title: 'Backup-Einstellungen gespeichert', color: 'success' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  } finally {
    savingSettings.value = false
  }
}

function statusBadge(b: Backup) {
  if (b.restoring) return { label: 'Wird wiederhergestellt', color: 'info' as const, icon: 'i-lucide-loader-circle' }
  if (b.status === 'pending') return { label: 'Läuft', color: 'warning' as const, icon: 'i-lucide-loader-circle' }
  if (b.status === 'failed') return { label: 'Fehlgeschlagen', color: 'error' as const, icon: 'i-lucide-circle-x' }
  return { label: 'Fertig', color: 'success' as const, icon: 'i-lucide-circle-check' }
}
</script>

<template>
  <div class="space-y-4 max-w-5xl">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div class="text-sm text-muted">
        <p v-if="data?.limit === 0">Backups sind für diesen Server deaktiviert.</p>
        <p v-else>
          {{ counted }} von {{ data?.limit }} Backups belegt.
          <template v-if="data?.target">Ziel: <span class="text-highlighted">{{ data.target.name }}</span> ({{ typeLabel[data.target.type] }})</template>
          <template v-else>Es ist noch kein Backup-Ziel eingerichtet.</template>
        </p>
        <p v-if="data?.limit" class="text-xs">Ist das Limit erreicht, ersetzt ein neues Backup das älteste ungesperrte.</p>
      </div>
      <UButton
        v-if="can('backup.create')"
        icon="i-lucide-archive"
        label="Backup erstellen"
        :disabled="!data?.target || !data?.limit || busy"
        @click="createOpen = true"
      />
    </div>

    <UTable :data="data?.backups ?? []" :columns="columns">
      <template #name-cell="{ row }">
        <div>
          <p class="font-medium text-highlighted flex items-center gap-1.5">
            <UIcon v-if="row.original.locked" name="i-lucide-lock" class="size-3.5 text-muted" />
            {{ row.original.name }}
          </p>
          <p class="text-xs text-muted">{{ new Date(row.original.createdAt).toLocaleString('de-DE') }}</p>
        </div>
      </template>
      <template #status-cell="{ row }">
        <div>
          <UTooltip :text="row.original.error ?? ''" :disabled="!row.original.error">
            <UBadge
              :label="statusBadge(row.original).label"
              :color="statusBadge(row.original).color"
              :icon="statusBadge(row.original).icon"
              :ui="{ leadingIcon: row.original.status === 'pending' || row.original.restoring ? 'animate-spin' : '' }"
              variant="subtle"
            />
          </UTooltip>
        </div>
      </template>
      <template #sizeBytes-cell="{ row }">
        <span class="text-sm tabular-nums">{{ row.original.status === 'completed' ? formatBytes(row.original.sizeBytes) : '–' }}</span>
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UButton
            v-if="can('backup.download') && row.original.status === 'completed'"
            icon="i-lucide-download"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Herunterladen"
            :href="`/api/servers/${id}/backups/${row.original.id}/download`"
            external
          />
          <UButton
            v-if="can('backup.restore') && row.original.status === 'completed'"
            icon="i-lucide-history"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Wiederherstellen"
            :disabled="busy"
            @click="restoreTarget = row.original; truncate = false"
          />
          <UButton
            v-if="can('backup.delete') && row.original.status === 'completed'"
            :icon="row.original.locked ? 'i-lucide-lock-open' : 'i-lucide-lock'"
            size="xs"
            color="neutral"
            variant="ghost"
            :aria-label="row.original.locked ? 'Entsperren' : 'Sperren'"
            @click="toggleLock(row.original)"
          />
          <UButton
            v-if="can('backup.delete') && row.original.status !== 'pending' && !row.original.restoring"
            icon="i-lucide-trash-2"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Löschen"
            :disabled="row.original.locked"
            @click="deleteTarget = row.original"
          />
        </div>
      </template>
      <template #empty>
        <UEmpty icon="i-lucide-archive" title="Noch keine Backups" />
      </template>
    </UTable>

    <UCard v-if="data?.canConfigure">
      <template #header>
        <p class="font-medium text-highlighted">Backup-Einstellungen (Admin)</p>
      </template>
      <form class="flex flex-wrap items-end gap-4" @submit.prevent="saveSettings">
        <UFormField label="Max. Backups" help="0 deaktiviert Backups">
          <UInputNumber v-model="settings.backupLimit" :min="0" :max="1000" class="w-32" />
        </UFormField>
        <UFormField label="Ziel" class="min-w-64">
          <USelect v-model="settings.backupTargetId" :items="targetItems" class="w-full" />
        </UFormField>
        <UButton type="submit" label="Speichern" :loading="savingSettings" />
      </form>
    </UCard>

    <UModal v-model:open="createOpen" title="Backup erstellen">
      <template #body>
        <form id="backup-form" class="space-y-4" @submit.prevent="createBackup">
          <UFormField label="Name" help="Leer lassen für Datum und Uhrzeit">
            <UInput v-model="createForm.name" class="w-full" maxlength="100" />
          </UFormField>
          <UFormField label="Ignorieren" help="Ein Muster pro Zeile, z. B. logs/ oder *.tmp oder /cache">
            <UTextarea v-model="createForm.ignore" :rows="4" class="w-full font-mono" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" label="Abbrechen" @click="createOpen = false" />
          <UButton type="submit" form="backup-form" label="Starten" :loading="creating" />
        </div>
      </template>
    </UModal>

    <UModal :open="!!restoreTarget" title="Backup wiederherstellen" @update:open="(v: boolean) => !v && (restoreTarget = null)">
      <template #body>
        <div class="space-y-4">
          <UAlert
            v-if="!serverOffline"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Server läuft"
            description="Stoppe den Server, bevor du ein Backup wiederherstellst."
          />
          <p class="text-sm">
            „{{ restoreTarget?.name }}“ wird in das Serververzeichnis entpackt. Vorhandene Dateien mit gleichem Namen werden überschrieben.
          </p>
          <USwitch v-model="truncate" label="Vorher alle Serverdateien löschen" description="Entfernt auch Dateien, die nicht im Backup enthalten sind." />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" label="Abbrechen" @click="restoreTarget = null" />
          <UButton color="warning" label="Wiederherstellen" :loading="restoring" :disabled="!serverOffline" @click="restore" />
        </div>
      </template>
    </UModal>

    <UModal :open="!!deleteTarget" title="Backup löschen" @update:open="(v: boolean) => !v && (deleteTarget = null)">
      <template #body>
        <p class="text-sm">„{{ deleteTarget?.name }}“ wird endgültig aus dem Speicherziel gelöscht.</p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" label="Abbrechen" @click="deleteTarget = null" />
          <UButton color="error" label="Löschen" :loading="deleting" @click="remove" />
        </div>
      </template>
    </UModal>
  </div>
</template>
