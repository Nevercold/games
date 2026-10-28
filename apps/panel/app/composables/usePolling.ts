/** Calls `fn` every `intervalMs` while the component is mounted (client only). */
export function usePolling(fn: () => unknown, intervalMs: number) {
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    timer = setInterval(fn, intervalMs)
  })
  onBeforeUnmount(() => clearInterval(timer))
}
