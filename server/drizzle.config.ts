import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for drizzle-kit');
}

const dbUrl = new URL(databaseUrl);
if (process.env.DB_USER) dbUrl.username = process.env.DB_USER;
if (process.env.DB_PASSWORD) dbUrl.password = process.env.DB_PASSWORD;

export default defineConfig({
  schema: './src/database/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: dbUrl.toString(),
  },
});
