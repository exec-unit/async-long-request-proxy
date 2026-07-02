import { applyDecorators } from '@nestjs/common'
import { ApiBody, ApiResponse } from '@nestjs/swagger'
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

/** Converts a Zod schema into an OpenAPI V3 SchemaObject. */
export function zodToOpenAPI(schema: z.ZodType): Record<string, unknown> | undefined {
  const registry = new OpenAPIRegistry()
  registry.register('Temp', schema)
  const generator = new OpenApiGeneratorV3(registry.definitions)
  const doc = generator.generateComponents()
  return doc.components?.schemas?.['Temp'] as unknown as
    Record<string, unknown> | undefined
}

/** Creates an ApiBody decorator from a Zod schema. */
export function ApiZodBody(schema: z.ZodType, description?: string) {
  const openApiSchema = zodToOpenAPI(schema)
  if (!openApiSchema) return applyDecorators()

  return applyDecorators(
    ApiBody({
      ...(description ? { description } : {}),
      // SchemaObject typings between zod-to-openapi and nestjs/swagger can have slight mismatches

      schema: openApiSchema,
    }),
  )
}

/** Creates an ApiResponse decorator from a Zod schema. */
export function ApiZodResponse(
  status: number | 'default',
  schema: z.ZodType,
  description?: string,
) {
  const openApiSchema = zodToOpenAPI(schema)
  if (!openApiSchema) return applyDecorators()

  return applyDecorators(
    ApiResponse({
      status,
      ...(description ? { description } : {}),

      schema: openApiSchema,
    }),
  )
}
