import type { Branding } from '#shared/branding'

/**
 * Applies branding (PLAN.md Theme-System, Stufe 1). Loaded during SSR and
 * transferred to the client via useState, so the first paint is correct.
 * Nuxt UI derives all --ui-* color tokens from appConfig.ui.colors.
 */
export default defineNuxtPlugin(async () => {
  const branding = useBranding()
  const loaded = useState('branding-loaded', () => false)

  if (!loaded.value) {
    try {
      branding.value = await $fetch<Branding>('/api/branding')
      loaded.value = true
    } catch {
      // keep defaults; the panel must render even if settings are unavailable
    }
  }

  const appConfig = useAppConfig()
  watchEffect(() => {
    appConfig.ui.colors.primary = branding.value.primary
    appConfig.ui.colors.neutral = branding.value.neutral
  })

  useHead({
    titleTemplate: (title) => (title ? `${title} · ${branding.value.appName}` : branding.value.appName),
    style: [{ key: 'branding-radius', innerHTML: () => `:root{--ui-radius:${branding.value.radius}rem}` }],
  })
})
