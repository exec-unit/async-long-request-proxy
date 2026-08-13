import type { AppConfig } from '#src/config/index.js'
import type { RedisModuleOptions } from '#libs/redis/index.js'

/**
 * Builds RedisModuleOptions from AppConfig.
 * Extracted to avoid copy-pasting the same useFactory block in AppModule and WorkerModule.
 */
export function buildRedisOptions(cfg: AppConfig): RedisModuleOptions {
  const { host, port, password, db, clusterMode, clusterNodes } = cfg.redis
  return {
    host,
    port,
    ...(password ? { password } : {}),
    db,
    clusterMode,
    ...(clusterNodes ? { clusterNodes } : {}),
  }
}
