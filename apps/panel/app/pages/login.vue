<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

definePageMeta({ layout: 'auth' })
useHead({ title: 'Anmelden' })

const schema = z.object({
  login: z.string().min(1, 'Pflichtfeld'),
  password: z.string().min(1, 'Pflichtfeld'),
})
type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({ login: '', password: '' })
const loading = ref(false)
const error = ref('')
const route = useRoute()
const { fetch: refreshSession } = useUserSession()

async function onSubmit(event: FormSubmitEvent<Schema>) {
  loading.value = true
  error.value = ''
  try {
    await $fetch('/api/auth/login', { method: 'POST', body: event.data })
    await refreshSession()
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') && !route.query.redirect.startsWith('//')
      ? route.query.redirect
      : '/'
    await navigateTo(redirect)
  } catch (err: any) {
    error.value = err?.statusCode === 429 ? 'Zu viele Versuche. Bitte später erneut versuchen.' : 'Anmeldung fehlgeschlagen.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
    <UFormField label="E-Mail oder Benutzername" name="login">
      <UInput v-model="state.login" autocomplete="username" autofocus class="w-full" />
    </UFormField>
    <UFormField label="Passwort" name="password">
      <UInput v-model="state.password" type="password" autocomplete="current-password" class="w-full" />
    </UFormField>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" icon="i-lucide-circle-alert" />
    <UButton type="submit" block :loading="loading">Anmelden</UButton>
  </UForm>
</template>
