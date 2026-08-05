import { defineConfig } from 'drizzle-kit'

const isProd = process.env.NODE_ENV === 'production'

export default defineConfig({
  schema: isProd
    ? './dist/src/database/drizzle/schema.js'
    : './src/database/drizzle/schema.ts',
  out: './src/database/drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] as string,
  },
  strict: true,
  verbose: true,
})
