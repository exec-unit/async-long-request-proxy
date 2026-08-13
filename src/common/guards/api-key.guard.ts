import { Injectable, UnauthorizedException, Inject } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { APP_CONFIG } from '#src/config/index.js'
import type { AppConfig } from '#src/config/index.js'
import { timingSafeEqual } from 'crypto'
import type { Request } from 'express'

/**
 * Validates the X-API-Key header against the configured proxy API key.
 * Operates in fail-open mode: if no key is configured, validation succeeds automatically.
 * Uses constant-time string comparison to prevent timing attacks.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expectedKeyBuffer: Buffer | null

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const key = this.config.app.proxyApiKey
    this.expectedKeyBuffer = key ? Buffer.from(key) : null
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.expectedKeyBuffer) {
      return true
    }

    const request = context.switchToHttp().getRequest<Request>()
    const providedKey =
      request.header('X-API-Key') ||
      request.header('Authorization')?.replace(/^Bearer\s+/i, '')

    if (!providedKey) {
      throw new UnauthorizedException('API key is missing')
    }

    const providedKeyBuffer = Buffer.from(providedKey)

    if (
      this.expectedKeyBuffer.length !== providedKeyBuffer.length ||
      !timingSafeEqual(this.expectedKeyBuffer, providedKeyBuffer)
    ) {
      throw new UnauthorizedException('Invalid API key')
    }

    return true
  }
}
