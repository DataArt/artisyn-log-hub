import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../database/database.constants';
import * as schema from '../database/schema';

export type UserSetting = {
  name: string;
  value: string | null;
};

/**
 * Plain CRUD over the generic `user_settings` key/value store. The server never
 * interprets a setting name and never parses a setting value — both are opaque
 * to it, and every method is scoped to a single `userId` supplied by the caller.
 */
@Injectable()
export class UserSettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async list(userId: number): Promise<UserSetting[]> {
    const rows = await this.db
      .select({
        name: schema.userSettings.settingName,
        value: schema.userSettings.settingValue,
      })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId));
    return rows.map((row) => ({ name: row.name, value: row.value ?? null }));
  }

  async get(userId: number, name: string): Promise<UserSetting> {
    const rows = await this.db
      .select({ value: schema.userSettings.settingValue })
      .from(schema.userSettings)
      .where(
        and(
          eq(schema.userSettings.userId, userId),
          eq(schema.userSettings.settingName, name),
        ),
      )
      .limit(1);
    return { name, value: rows[0]?.value ?? null };
  }

  async set(userId: number, name: string, value: string): Promise<UserSetting> {
    const [row] = await this.db
      .insert(schema.userSettings)
      .values({ userId, settingName: name, settingValue: value })
      .onConflictDoUpdate({
        target: [schema.userSettings.userId, schema.userSettings.settingName],
        set: { settingValue: value },
      })
      .returning({
        name: schema.userSettings.settingName,
        value: schema.userSettings.settingValue,
      });
    return { name: row.name, value: row.value ?? null };
  }

  /** Idempotent — deleting a setting that does not exist is not an error. */
  async remove(userId: number, name: string): Promise<void> {
    await this.db
      .delete(schema.userSettings)
      .where(
        and(
          eq(schema.userSettings.userId, userId),
          eq(schema.userSettings.settingName, name),
        ),
      );
  }
}
