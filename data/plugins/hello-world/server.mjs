// Example plugin: logs node connections. Delete this folder to disable it.
export function setup(ctx) {
  ctx.hooks.hook('node.connected', ({ nodeId, daemonVersion }) => {
    ctx.log.info(`node ${nodeId} connected (daemon ${daemonVersion})`)
  })
  ctx.hooks.hook('node.disconnected', ({ nodeId }) => {
    ctx.log.info(`node ${nodeId} disconnected`)
  })
}
