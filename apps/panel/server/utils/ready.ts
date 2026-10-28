/**
 * Nitro does not await async plugins, so requests can arrive before
 * migrations finished. Startup work registers here; the ready middleware
 * holds requests until everything resolved.
 */
const pending: Promise<unknown>[] = []

export function registerStartupTask(task: Promise<unknown>) {
  // Errors surface through whenReady(); this only prevents an unhandled
  // rejection warning when a task fails before the first request.
  task.catch(() => {})
  pending.push(task)
}

let ready: Promise<void> | undefined

export function whenReady() {
  ready ??= Promise.all(pending).then(() => undefined)
  return ready
}
