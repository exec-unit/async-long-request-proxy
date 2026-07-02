import {
  createParamDecorator,
  type ExecutionContext,
  BadRequestException,
} from '@nestjs/common'
import type { z } from 'zod'
import { ZodError } from 'zod'
import type { Request } from 'express'
import { ApiBody, ApiQuery, ApiParam } from '@nestjs/swagger'
import { zodToOpenAPI } from './swagger.decorators.js'

const SKIP_STRICT = Symbol('SKIP_STRICT')
type SchemaWithMetadata = z.ZodType & { [SKIP_STRICT]?: boolean }

// Cache strict schemas to avoid recreating them on every request
const strictSchemaCache = new WeakMap<z.ZodType, z.ZodType>()

export function allowUnknown<T extends z.ZodType>(schema: T): T {
  ;(schema as SchemaWithMetadata)[SKIP_STRICT] = true
  return schema
}

function getStrictSchema(schema: z.ZodType): z.ZodType {
  const schemaWithMeta = schema as SchemaWithMetadata

  if (schemaWithMeta[SKIP_STRICT] === true) {
    return schema
  }

  if (!('strict' in schema && typeof schema.strict === 'function')) {
    return schema
  }

  let cached = strictSchemaCache.get(schema)
  if (!cached) {
    cached = (schema.strict as () => z.ZodType)()
    strictSchemaCache.set(schema, cached)
  }
  return cached
}

/** Validates `request.body` with the given Zod schema and injects Swagger metadata. */
export function ParseBody(schema: z.ZodType) {
  const paramDecorator = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>()
    try {
      return getStrictSchema(schema).parse(request.body)
    } catch (error) {
      if (error instanceof ZodError) throw error
      throw new BadRequestException('Validation failed')
    }
  })()

  return (target: object, propertyKey: string | symbol, parameterIndex: number) => {
    paramDecorator(target, propertyKey, parameterIndex)

    const openApiSchema = zodToOpenAPI(schema)
    const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey)
    if (descriptor && openApiSchema) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      ApiBody({ schema: openApiSchema as any })(target, propertyKey, descriptor)
    }
  }
}

/** Validates `request.query` with the given Zod schema and injects Swagger metadata. */
export function ParseQuery(schema: z.ZodType) {
  const paramDecorator = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>()
    try {
      return schema.parse(request.query)
    } catch (error) {
      if (error instanceof ZodError) throw error
      throw new BadRequestException('Validation failed')
    }
  })()

  return (target: object, propertyKey: string | symbol, parameterIndex: number) => {
    paramDecorator(target, propertyKey, parameterIndex)

    const openApiSchema = zodToOpenAPI(schema)
    const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey)

    if (
      descriptor &&
      openApiSchema &&
      'type' in openApiSchema &&
      openApiSchema['type'] === 'object' &&
      'properties' in openApiSchema
    ) {
      const properties = openApiSchema['properties'] as Record<string, unknown>
      const requiredFields = (openApiSchema['required'] as string[] | undefined) ?? []

      for (const [key, propSchema] of Object.entries(properties)) {
        const isRequired = requiredFields.includes(key)
        const desc = (propSchema as { description?: string }).description

        ApiQuery({
          name: key,
          required: isRequired,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
          schema: propSchema as any,
          ...(desc ? { description: desc } : {}),
        })(target, propertyKey, descriptor)
      }
    }
  }
}

/** Validates `request.params` with the given Zod schema and injects Swagger metadata. */
export function ParseParams(schema: z.ZodType) {
  const paramDecorator = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>()
    try {
      return schema.parse(request.params)
    } catch (error) {
      if (error instanceof ZodError) throw error
      throw new BadRequestException('Validation failed')
    }
  })()

  return (target: object, propertyKey: string | symbol, parameterIndex: number) => {
    paramDecorator(target, propertyKey, parameterIndex)

    const openApiSchema = zodToOpenAPI(schema)
    const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey)

    if (
      descriptor &&
      openApiSchema &&
      'type' in openApiSchema &&
      openApiSchema['type'] === 'object' &&
      'properties' in openApiSchema
    ) {
      const properties = openApiSchema['properties'] as Record<string, unknown>
      for (const [key, propSchema] of Object.entries(properties)) {
        const desc = (propSchema as { description?: string }).description

        ApiParam({
          name: key,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
          schema: propSchema as any,
          ...(desc ? { description: desc } : {}),
        })(target, propertyKey, descriptor)
      }
    }
  }
}
