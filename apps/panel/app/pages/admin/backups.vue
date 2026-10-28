<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

type TargetType = 'local' | 's3' | 'sftp'
interface Target {
  id: string
  name: string
  type: TargetType
  isDefault: boolean
  config: Record<string, any>
  secrets: Record<string, boolean>
  error: string | null
  backups: number
}
interface TargetList {
  targets: Target[]
  nodes: { id: string; name: string; online: boolean }[]
}

const toast = useToast()
const { data, refresh } = await useFetch<TargetList>('/api/admin/backup-targets')

const TYPE_LABEL: Record<TargetType, string> = { local: 'Lokal (Node)', s3: 'S3-kompatibel', sftp: 'SFTP' }
const typeItems = (Object.keys(TYPE_LABEL) as TargetType[]).map((value) => ({ label: TYPE_LABEL[value], value }))

const columns: TableColumn<Target>[] = [
  { accessorKey: 'name', header: 'Ziel' },
  { accessorKey: 'type', header: 'Typ' },
  { accessorKey: 'backups', header: 'Backups' },
  actionsColumn<Target>(),
]

function describe(t: Target) {
  const c = t.config
  if (t.type === 's3') return `${c.bucket} @ ${c.endpoint}${c.prefix ? '/' + c.prefix : ''}`
  if (t.type === 'sftp') return `${c.username}@${c.host}:${c.port ?? 22}${c.path ? ' ' + c.path : ''}`
  return c.subdir ? `Backup-Verzeichnis/${c.subdir}` : 'Backup-Verzeichnis der jeweiligen Node'
}

// --- form ----------------------------------------------------------------------
const emptyConfig = (): Record<TargetType, Record<string, any>> => ({
  local: { subdir: '' },
  s3: { endpoint: '', region: '', bucket: '', prefix: '', accessKey: '', secretKey: '', insecure: false, pathStyle: false },
  sftp: { host: '', port: 22, username: '', password: '', privateKey: '', path: '', hostKey: '' },
})
const open = ref(false)
const editing = ref<Target | null>(null)
const form = reactive({ name: '', type: 'local' as TargetType, isDefault: false, configs: emptyConfig() })
const cfg = computed(() => form.configs[form.type])
const saving = ref(false)

function openNew() {
  editing.value = null
  Object.assign(form, { name: '', type: 'local', isDefault: !data.value?.targets.length, configs: emptyConfig() })
  test.result = null
  open.value = true
}

function openEdit(t: Target) {
  editing.value = t
  const configs = emptyConfig()
  configs[t.type] = { ...configs[t.type], ...t.config }
  Object.assign(form, { name: t.name, type: t.type, isDefault: t.isDefault, configs })
  test.result = null
  open.value = true
}

/** Drops empty optional strings so the API sees "unset" instead of "". */
function payloadConfig() {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(cfg.value)) {
    if (v === '' && !['secretKey', 'password', 'privateKey', 'hostKey'].includes(k)) continue
    out[k] = v
  }
  return out
}

async function save() {
  saving.value = true
  try {
    const body = { name: form.name, type: form.type, isDefault: form.isDefault, config: payloadConfig() }
    if (editing.value) await $fetch(`/api/admin/backup-targets/${editing.value.id}`, { method: 'PATCH', body })
    else await $fetch('/api/admin/backup-targets', { method: 'POST', body })
    open.value = false
    await refresh()
  } catch (err) {
    toast.add({ title: 'Nicht gespeichert', description: errorMessage(err), color: 'error' })
  } finally {
    saving.value = false
  }
}

// --- connection test -------------------------------------------------------------
const test = reactive({
  nodeId: '' as string,
  running: false,
  result: null as null | { ok: boolean; message?: string; hostKeyFingerprint: string | null },
})
watchEffect(() => {
  if (!test.nodeId) test.nodeId = data.value?.nodes.find((n) => n.online)?.id ?? data.value?.nodes[0]?.id ?? ''
})
const nodeItems = computed(() => (data.value?.nodes ?? []).map((n) => ({ label: `${n.name}${n.online ? '' : ' (offline)'}`, value: n.id, disabled: !n.online })))

async function runTest() {
  test.running = true
  test.result = null
  try {
    test.result = await $fetch<{ ok: boolean; message?: string; hostKeyFingerprint: string | null }>('/api/admin/backup-targets/test', {
      method: 'POST',
      body: { nodeId: test.nodeId, id: editing.value?.id, type: form.type, config: payloadConfig() },
    })
  } catch (err) {
    test.result = { ok: false, message: errorMessage(err), hostKeyFingerprint: null }
  } finally {
    test.running = false
  }
}

function acceptFingerprint() {
  if (test.result?.hostKeyFingerprint) {
    form.configs.sftp.hostKey = test.result.hostKeyFingerprint
    runTest()
  }
}

// --- delete --------------------------------------------------------------------
const deleteTarget = ref<Target | null>(null)
async function remove() {
  if (!deleteTarget.value) return
  try {
    await $fetch(`/api/admin/backup-targets/${deleteTarget.value.id}`, { method: 'DELETE' })
    deleteTarget.value = null
    await refresh()
  } catch (err) {
    toast.add({ title: 'Nicht gelöscht', description: errorMessage(err), color: 'error' })
  }
}

const secretPlaceholder = (field: string) => (editing.value?.secrets[field] ? 'gespeichert – leer lassen zum Beibehalten' : '')
</script>

<template>
  <UDashboardPanel id="admin-backups">
    <template #header>
      <UDashboardNavbar title="Backup-Ziele">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton icon="i-lucide-plus" label="Ziel hinzufügen" @click="openNew" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="text-sm text-muted shrink-0">
        Backups werden vom Daemon direkt zum Ziel gestreamt (tar + zstd). Zugangsdaten liegen verschlüsselt in der Datenbank und
        gehen nur für den jeweiligen Auftrag an die Node.
      </p>
      <UTable :data="data?.targets ?? []" :columns="columns">
        <template #name-cell="{ row }">
          <div>
            <p class="font-medium text-highlighted flex items-center gap-2">
              {{ row.original.name }}
              <UBadge v-if="row.original.isDefault" label="Standard" size="sm" variant="subtle" />
            </p>
            <p class="text-xs text-muted font-mono">{{ describe(row.original) }}</p>
            <p v-if="row.original.error" class="text-xs text-error">{{ row.original.error }}</p>
          </div>
        </template>
        <template #type-cell="{ row }">
          <span class="text-sm">{{ TYPE_LABEL[row.original.type] }}</span>
        </template>
        <template #backups-cell="{ row }">
          <span class="text-sm tabular-nums">{{ row.original.backups }}</span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" aria-label="Bearbeiten" @click="openEdit(row.original)" />
            <UButton
              icon="i-lucide-trash-2"
              size="xs"
              color="neutral"
              variant="ghost"
              aria-label="Löschen"
              :disabled="row.original.backups > 0"
              @click="deleteTarget = row.original"
            />
          </div>
        </template>
        <template #empty>
          <UEmpty icon="i-lucide-hard-drive-upload" title="Noch kein Backup-Ziel" description="Ohne Ziel können keine Backups erstellt werden." />
        </template>
      </UTable>

      <UModal v-model:open="open" :title="editing ? `${editing.name} bearbeiten` : 'Backup-Ziel hinzufügen'" :ui="{ content: 'sm:max-w-2xl' }">
        <template #body>
          <form id="target-form" class="space-y-4" @submit.prevent="save">
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField label="Name" required>
                <UInput v-model="form.name" class="w-full" maxlength="64" />
              </UFormField>
              <UFormField label="Typ">
                <USelect v-model="form.type" :items="typeItems" :disabled="!!editing" class="w-full" />
              </UFormField>
            </div>

            <template v-if="form.type === 'local'">
              <UFormField label="Unterverzeichnis" help="Innerhalb von backup_dir der Node (Standard: data_dir/backups). Lokale Backups bleiben an die Node gebunden.">
                <UInput v-model="cfg.subdir" class="w-full font-mono" placeholder="optional" />
              </UFormField>
            </template>

            <template v-else-if="form.type === 's3'">
              <div class="grid gap-4 sm:grid-cols-2">
                <UFormField label="Endpoint" required help="host[:port] ohne https://">
                  <UInput v-model="cfg.endpoint" class="w-full font-mono" placeholder="s3.eu-central-1.amazonaws.com" />
                </UFormField>
                <UFormField label="Region">
                  <UInput v-model="cfg.region" class="w-full font-mono" placeholder="eu-central-1" />
                </UFormField>
                <UFormField label="Bucket" required>
                  <UInput v-model="cfg.bucket" class="w-full font-mono" />
                </UFormField>
                <UFormField label="Präfix">
                  <UInput v-model="cfg.prefix" class="w-full font-mono" placeholder="panel-backups" />
                </UFormField>
                <UFormField label="Access Key" required>
                  <UInput v-model="cfg.accessKey" class="w-full font-mono" autocomplete="off" />
                </UFormField>
                <UFormField label="Secret Key" :required="!editing?.secrets.secretKey">
                  <UInput v-model="cfg.secretKey" type="password" class="w-full font-mono" autocomplete="new-password" :placeholder="secretPlaceholder('secretKey')" />
                </UFormField>
              </div>
              <div class="flex flex-wrap gap-6">
                <USwitch v-model="cfg.pathStyle" label="Path-Style-Adressierung" description="Für MinIO und manche Anbieter" />
                <USwitch v-model="cfg.insecure" label="Ohne TLS (http)" description="Nur für lokale Tests" />
              </div>
            </template>

            <template v-else>
              <div class="grid gap-4 sm:grid-cols-3">
                <UFormField label="Host" required class="sm:col-span-2">
                  <UInput v-model="cfg.host" class="w-full font-mono" />
                </UFormField>
                <UFormField label="Port">
                  <UInputNumber v-model="cfg.port" :min="1" :max="65535" class="w-full" />
                </UFormField>
                <UFormField label="Benutzer" required>
                  <UInput v-model="cfg.username" class="w-full font-mono" autocomplete="off" />
                </UFormField>
                <UFormField label="Passwort">
                  <UInput v-model="cfg.password" type="password" class="w-full" autocomplete="new-password" :placeholder="secretPlaceholder('password')" />
                </UFormField>
                <UFormField label="Verzeichnis">
                  <UInput v-model="cfg.path" class="w-full font-mono" placeholder="backups" />
                </UFormField>
              </div>
              <UFormField label="Private Key" help="OpenSSH- oder PEM-Format, unverschlüsselt. Alternativ zum Passwort.">
                <UTextarea v-model="cfg.privateKey" :rows="3" class="w-full font-mono text-xs" :placeholder="secretPlaceholder('privateKey')" />
              </UFormField>
              <UFormField label="Host-Key-Fingerprint" required help="Wird beim Verbindungstest angezeigt und muss bestätigt werden.">
                <UInput v-model="cfg.hostKey" class="w-full font-mono" placeholder="SHA256:…" />
              </UFormField>
            </template>

            <USwitch v-model="form.isDefault" label="Standardziel" description="Gilt für alle Server ohne eigenes Ziel" />

            <USeparator />
            <div class="flex flex-wrap items-end gap-3">
              <UFormField label="Verbindung testen von Node" class="min-w-56">
                <USelect v-model="test.nodeId" :items="nodeItems" class="w-full" />
              </UFormField>
              <UButton color="neutral" variant="outline" icon="i-lucide-plug-zap" label="Testen" :loading="test.running" :disabled="!test.nodeId" @click="runTest" />
            </div>
            <UAlert
              v-if="test.result?.ok"
              color="success"
              variant="subtle"
              icon="i-lucide-circle-check"
              title="Verbindung funktioniert"
              description="Testdatei geschrieben, gelesen und gelöscht."
            />
            <UAlert
              v-else-if="test.result && test.result.hostKeyFingerprint && !cfg.hostKey"
              color="warning"
              variant="subtle"
              icon="i-lucide-key-round"
              title="Host-Key bestätigen"
              :description="`Der Server meldet ${test.result.hostKeyFingerprint}. Vergleiche den Wert mit dem Server, bevor du ihn übernimmst.`"
              :actions="[{ label: 'Übernehmen und erneut testen', onClick: acceptFingerprint }]"
            />
            <UAlert v-else-if="test.result" color="error" variant="subtle" icon="i-lucide-circle-x" title="Test fehlgeschlagen" :description="test.result.message" />
          </form>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2 w-full">
            <UButton color="neutral" variant="ghost" label="Abbrechen" @click="open = false" />
            <UButton type="submit" form="target-form" label="Speichern" :loading="saving" :disabled="!form.name.trim()" />
          </div>
        </template>
      </UModal>

      <UModal :open="!!deleteTarget" title="Backup-Ziel löschen" @update:open="(v: boolean) => !v && (deleteTarget = null)">
        <template #body>
          <p class="text-sm">„{{ deleteTarget?.name }}“ wird entfernt. Server, die es nutzen, verwenden danach das Standardziel.</p>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2 w-full">
            <UButton color="neutral" variant="ghost" label="Abbrechen" @click="deleteTarget = null" />
            <UButton color="error" label="Löschen" @click="remove" />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
