<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

definePageMeta({ layout: 'auth' })
useHead({ title: 'Ersteinrichtung' })

const schema = z
  .object({
    email: z.email('Ungültige E-Mail'),
    username: z.string().min(3, 'Mindestens 3 Zeichen').max(32).regex(/^[a-zA-Z0-9_.-]+$/, 'Nur Buchstaben, Ziffern, _ . -'),
    password: z.string().min(10, 'Mindestens 10 Zeichen'),
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, { message: 'Passwörter stimmen nicht überein', path: ['confirm'] })
type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({ email: '', username: '', password: '', confirm: '' })
const loading = ref(false)
const error = ref('')
const { fetch: refreshSession } = useUserSession()
const needsSetup = useState<boolean | null>('needs-setup')

async function onSubmit(event: FormSubmitEvent<Schema>) {
  loading.value = true
  error.value = ''
  try {
    const { confirm: _, ...body } = event.data
    await $fetch('/api/setup', { method: 'POST', body })
    needsSetup.value = false
    await refreshSession()
    await navigateTo('/')
  } catch (err: any) {
    error.value = err?.data?.statusMessage ?? err?.statusMessage ?? 'Einrichtung fehlgeschlagen.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-sm text-muted">Lege das erste Administrator-Konto an.</p>
    <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
      <UFormField label="E-Mail" name="email">
        <UInput v-model="state.email" type="email" autocomplete="email" class="w-full" />
      </UFormField>
      <UFormField label="Benutzername" name="username">
        <UInput v-model="state.username" autocomplete="username" class="w-full" />
      </UFormField>
      <UFormField label="Passwort" name="password">
        <UInput v-model="state.password" type="password" autocomplete="new-password" class="w-full" />
      </UFormField>
      <UFormField label="Passwort wiederholen" name="confirm">
        <UInput v-model="state.confirm" type="password" autocomplete="new-password" class="w-full" />
      </UFormField>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" icon="i-lucide-circle-alert" />
      <UButton type="submit" block :loading="loading">Konto anlegen</UButton>
    </UForm>
  </div>
</template>
