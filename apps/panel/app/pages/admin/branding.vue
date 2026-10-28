<script setup lang="ts">
import { brandingSchema, NEUTRAL_COLORS, PRIMARY_COLORS, type Branding } from '#shared/branding'
import type { FormSubmitEvent } from '@nuxt/ui'

useHead({ title: 'Branding' })
const toast = useToast()
const branding = useBranding()

// Edit a copy; the live preview applies it to the global state immediately,
// "Verwerfen" restores the saved version.
const saved = ref<Branding>({ ...branding.value })
const state = reactive<Branding>({ ...branding.value })
watch(state, (v) => { branding.value = { ...v } }, { deep: true })
onBeforeRouteLeave(() => { branding.value = { ...saved.value } })

const primaryItems = PRIMARY_COLORS.map((c) => ({ label: c, value: c }))
const neutralItems = NEUTRAL_COLORS.map((c) => ({ label: c, value: c }))

const saving = ref(false)
async function onSubmit(event: FormSubmitEvent<Branding>) {
  saving.value = true
  try {
    saved.value = await $fetch<Branding>('/api/admin/branding', { method: 'PUT', body: event.data })
    branding.value = { ...saved.value }
    toast.add({ title: 'Branding gespeichert', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  } finally {
    saving.value = false
  }
}

function reset() {
  Object.assign(state, saved.value)
}
</script>

<template>
  <UDashboardPanel id="branding">
    <template #header>
      <UDashboardNavbar title="Branding">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="grid gap-6 lg:grid-cols-2">
        <UCard>
          <UForm id="branding-form" :schema="brandingSchema" :state="state" class="space-y-4" @submit="onSubmit">
            <UFormField label="Panel-Name" name="appName">
              <UInput v-model="state.appName" class="w-full" />
            </UFormField>
            <UFormField label="Logo-URL" name="logoUrl" help="https-URL oder data:image. Leer lassen für das Standard-Icon.">
              <UInput v-model="state.logoUrl" class="w-full" placeholder="https://…" />
            </UFormField>
            <div class="grid grid-cols-2 gap-4">
              <UFormField label="Primärfarbe" name="primary">
                <USelect v-model="state.primary" :items="primaryItems" class="w-full" />
              </UFormField>
              <UFormField label="Neutralfarbe" name="neutral">
                <USelect v-model="state.neutral" :items="neutralItems" class="w-full" />
              </UFormField>
            </div>
            <UFormField :label="`Eckenradius: ${state.radius} rem`" name="radius">
              <USlider v-model="state.radius" :min="0" :max="1" :step="0.125" />
            </UFormField>
            <div class="flex justify-end gap-2">
              <UButton color="neutral" variant="ghost" label="Verwerfen" @click="reset" />
              <UButton type="submit" label="Speichern" :loading="saving" />
            </div>
          </UForm>
        </UCard>

        <UCard>
          <template #header><p class="font-medium text-highlighted">Vorschau</p></template>
          <div class="space-y-4">
            <div class="flex flex-wrap gap-2">
              <UButton label="Primär" />
              <UButton label="Outline" variant="outline" />
              <UButton label="Neutral" color="neutral" variant="subtle" />
            </div>
            <div class="flex flex-wrap gap-2">
              <UBadge label="online" color="success" variant="subtle" />
              <UBadge label="primär" variant="subtle" />
              <UBadge label="offline" color="neutral" variant="subtle" />
            </div>
            <UInput placeholder="Eingabefeld" class="w-full" />
            <UProgress :model-value="62" />
            <UAlert title="Hinweis" description="So sehen Meldungen im Panel aus." icon="i-lucide-info" variant="subtle" />
          </div>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
