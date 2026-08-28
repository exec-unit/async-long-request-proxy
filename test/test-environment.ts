import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis'
import { execSync } from 'child_process'
import { Test, TestingModule } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { ExpressAdapter } from '@nestjs/platform-express'

export class TestEnvironment {
  private pgContainer: StartedPostgreSqlContainer | undefined
  private redisContainer: StartedRedisContainer | undefined

  async start() {
    this.pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('async_proxy_test')
      .start()

    this.redisContainer = await new RedisContainer('redis:7-alpine').start()

    process.env['DATABASE_URL'] = this.pgContainer.getConnectionUri()
    process.env['REDIS_HOST'] = this.redisContainer.getHost()
    process.env['REDIS_PORT'] = this.redisContainer.getPort().toString()

    execSync('pnpm exec drizzle-kit push --force', { env: process.env, stdio: 'inherit' })
  }

  async createApplication(): Promise<INestApplication> {
    const { AppModule } = await import('#src/app.module.js')

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    const app = moduleFixture.createNestApplication(new ExpressAdapter())
    await app.init()

    return app
  }

  async stop() {
    await this.pgContainer?.stop()
    await this.redisContainer?.stop()
  }
}
