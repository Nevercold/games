<script setup lang="ts">
const props = defineProps<{ token: string }>()

const panelUrl = useRequestURL().origin
const config = computed(() =>
  [
    `panel_url: ${panelUrl}`,
    `token: ${props.token}`,
    `data_dir: /var/lib/panel-daemon`,
  ].join('\n'),
)

const toast = useToast()
async function copy(text: string) {
  await navigator.clipboard.writeText(text)
  toast.add({ title: 'Kopiert', icon: 'i-lucide-check', color: 'success' })
}
</script>

<template>
  <div class="space-y-4">
    <UAlert
      color="warning"
      variant="subtle"
      icon="i-lucide-key-round"
      title="Token jetzt sichern"
      description="Das Token wird nur einmal angezeigt. Bei Verlust kannst du es auf der Node-Seite neu erzeugen."
    />
    <div class="space-y-1">
      <p class="text-sm font-medium text-highlighted">Daemon-Konfiguration (config.yaml)</p>
      <div class="relative">
        <pre class="text-xs bg-elevated rounded-md p-3 pr-12 overflow-x-auto font-mono">{{ config }}</pre>
        <UButton
          class="absolute top-2 right-2"
          icon="i-lucide-copy"
          size="xs"
          color="neutral"
          variant="ghost"
          aria-label="Konfiguration kopieren"
          @click="copy(config)"
        />
      </div>
    </div>
    <p class="text-sm text-muted">
      Der Daemon verbindet sich selbst mit dem Panel. Auf der Node sind keine eingehenden Ports nötig, außer den Spielports.
    </p>
  </div>
</template>
