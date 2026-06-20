import type { ClusterNode } from 'ioredis'

/**
 * Parses a comma-separated cluster node string into ioredis ClusterNode entries.
 * Expected format: "host1:6379,host2:6379" - port defaults to 6379 if omitted.
 */
export function parseClusterNodes(raw: string): ClusterNode[] {
  return raw.split(',').map((entry) => {
    const [host, portStr] = entry.trim().split(':')
    const port = portStr ? parseInt(portStr, 10) : 6379
    if (!host || isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid cluster node entry: "${entry.trim()}"`)
    }
    return { host, port }
  })
}
