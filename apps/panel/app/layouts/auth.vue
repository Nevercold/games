<script setup lang="ts">
const branding = useBranding()
</script>

<template>
  <div class="min-h-dvh flex items-center justify-center bg-default p-4">
    <div class="w-full max-w-sm space-y-6">
      <div class="flex flex-col items-center gap-3">
        <img v-if="branding.logoUrl" :src="branding.logoUrl" alt="" class="h-12 w-auto">
        <UIcon v-else name="i-lucide-server" class="size-10 text-primary" />
        <h1 class="text-xl font-semibold text-highlighted">{{ branding.appName }}</h1>
      </div>
      <UCard>
        <slot />
      </UCard>
    </div>
  </div>
</template>
