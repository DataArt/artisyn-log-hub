import { config } from 'dotenv';
config();

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { hashPassword } from '../utils/password-hash';
import { generateApiKey } from '../api-keys/api-key.util';
import * as schema from './schema/index';
import { users, apiKeys } from './schema/index';
import { isProduction } from '../common/runtime-env';

async function seed(): Promise<void> {
  // The seed creates a fixed-password debug user — dev databases only.
  if (isProduction()) {
    console.error(
      'Refusing to seed the database in production (NODE_ENV=production)',
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

  // --- Create user (idempotent) ---
  const DEBUG_EMAIL = 'debug-user@arrakis.test';
  const DEBUG_PASSWORD = 'Debug@Pass123!';

  let userId: number;

  const existingUsers = await db
    .select()
    .from(users)
    .where(eq(users.email, DEBUG_EMAIL));

  if (existingUsers.length === 0) {
    const passwordHash = await hashPassword(DEBUG_PASSWORD);
    const inserted = await db
      .insert(users)
      .values({ email: DEBUG_EMAIL, passwordHash })
      .returning({ id: users.id });
    userId = inserted[0].id;
    console.log(`Created user with id=${userId}`);
  } else {
    userId = existingUsers[0].id;
    console.log(`User already exists with id=${userId}`);
  }

  // --- Create API key (idempotent) ---
  const DEBUG_KEY_NAME = 'debug-key';

  const existingKeys = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.name, DEBUG_KEY_NAME)));

  let rawKey: string | null = null;

  if (existingKeys.length > 0) {
    console.log('API key already exists, skipping');
  } else {
    const { key, slug } = generateApiKey();
    rawKey = key;
    const keyHash = await hashPassword(key);
    await db.insert(apiKeys).values({
      userId,
      name: DEBUG_KEY_NAME,
      slug,
      keyHash,
    });
    // Never print the full secret — the key itself goes to log-hub.local.json.
    console.log(`Created API key with prefix ${slug}-…`);
  }

  // --- Write .artisyn/config/log-hub.json + log-hub.local.json ---
  // seed.ts is at server/src/database/seed.ts
  // __dirname at runtime = server/src/database  (3 levels into server)
  // repo root = 3 levels up from __dirname
  const repoRoot = path.resolve(__dirname, '../../..');
  const configDir = path.join(repoRoot, '.artisyn', 'config');
  const baseConfigPath = path.join(configDir, 'log-hub.json');
  const localConfigPath = path.join(configDir, 'log-hub.local.json');
  const gitignorePath = path.join(configDir, '.gitignore');

  const readJsonConfig = (filePath: string): Record<string, unknown> => {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  };

  const writeJsonConfig = (
    filePath: string,
    obj: Record<string, unknown>,
  ): void => {
    fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  };

  if (rawKey !== null) {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, 'log-hub.local.json\n', 'utf8');
      console.log(`Created ${gitignorePath}`);
    }

    // Merge apiKey into log-hub.local.json, preserving other keys.
    const existingLocal = readJsonConfig(localConfigPath);
    const mergedLocal = { ...existingLocal, apiKey: rawKey };
    writeJsonConfig(localConfigPath, mergedLocal);
    console.log(`Updated ${localConfigPath}`);

    // Only write serverUrl into log-hub.json when absent — never overwrite a
    // developer's existing value.
    const existingBase = readJsonConfig(baseConfigPath);
    if (!Object.prototype.hasOwnProperty.call(existingBase, 'serverUrl')) {
      const mergedBase = {
        ...existingBase,
        serverUrl: 'http://localhost:3000',
      };
      writeJsonConfig(baseConfigPath, mergedBase);
      console.log(`Updated ${baseConfigPath}`);
    }
  } else {
    console.log('Skipping config update — no new API key was generated');
  }

  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
