export default defineNitroPlugin(() => {
  const { pluginsDir } = useRuntimeConfig()
  registerStartupTask(loadPlugins(pluginsDir, usePanelHooks()))
})
