import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { hashPassword, comparePassword } from '../utils/password-hash';
import { and, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../database/database.constants';
import * as schema from '../database/schema';
import { invalidateApiKeyCache } from '../cluster/api-key-cache-ipc';
import { apiKeyCache } from './api-key-cache';
import { generateApiKey } from './api-key.util';

function toPublic(row: {
  id: number;
  name: string;
  slug: string;
  createdAt: Date;
  expiresAt: Date | null;
}) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    created_at: row.createdAt,
    expires_at: row.expiresAt ?? null,
  };
}

@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async listByUser(userId: number) {
    const rows = await this.db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        slug: schema.apiKeys.slug,
        createdAt: schema.apiKeys.createdAt,
        expiresAt: schema.apiKeys.expiresAt,
      })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.userId, userId));
    return rows.map(toPublic);
  }

  async create(userId: number, name: string, expiresAt?: string) {
    const existing = await this.db
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(
        and(eq(schema.apiKeys.userId, userId), eq(schema.apiKeys.name, name)),
      );
    if (existing.length > 0) {
      throw new ConflictException('API key name already exists');
    }

    const { key, slug } = generateApiKey();
    const keyHash = await hashPassword(key);

    const rows = await this.db
      .insert(schema.apiKeys)
      .values({
        userId,
        name,
        slug,
        keyHash,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      })
      .returning({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        slug: schema.apiKeys.slug,
        createdAt: schema.apiKeys.createdAt,
        expiresAt: schema.apiKeys.expiresAt,
      });

    return { ...toPublic(rows[0]), key };
  }

  async update(
    id: number,
    userId: number,
    updates: { name?: string; expires_at?: string | null },
  ) {
    if (updates.name === undefined && updates.expires_at === undefined) {
      throw new BadRequestException(
        'At least one of name or expires_at must be provided',
      );
    }

    const existing = await this.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, id));

    if (existing.length === 0) {
      throw new NotFoundException('API key not found');
    }

    if (existing[0].userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    if (updates.name !== undefined) {
      const nameConflict = await this.db
        .select({ id: schema.apiKeys.id })
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.userId, userId),
            eq(schema.apiKeys.name, updates.name),
          ),
        );
      if (nameConflict.length > 0 && nameConflict[0].id !== id) {
        throw new ConflictException('API key name already exists');
      }
    }

    const setValues: Partial<typeof schema.apiKeys.$inferInsert> = {};
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.expires_at !== undefined) {
      setValues.expiresAt = updates.expires_at
        ? new Date(updates.expires_at)
        : null;
    }

    const rows = await this.db
      .update(schema.apiKeys)
      .set(setValues)
      .where(eq(schema.apiKeys.id, id))
      .returning({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        slug: schema.apiKeys.slug,
        createdAt: schema.apiKeys.createdAt,
        expiresAt: schema.apiKeys.expiresAt,
      });

    if (
      setValues.expiresAt !== undefined &&
      (setValues.expiresAt?.getTime() ?? null) !==
        (existing[0].expiresAt?.getTime() ?? null)
    ) {
      invalidateApiKeyCache({ keyId: id });
    }

    return toPublic(rows[0]);
  }

  async delete(id: number, userId: number) {
    const existing = await this.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, id));

    if (existing.length === 0) {
      throw new NotFoundException('API key not found');
    }

    if (existing[0].userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    await this.db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    invalidateApiKeyCache({ keyId: id });
  }

  async validateApiKey(rawKey: string): Promise<number> {
    if (!rawKey || rawKey.length < 6) {
      throw new UnauthorizedException();
    }

    // Hit: skip the argon2 compare entirely; only expiry needs re-checking.
    // Deletes and expiry changes invalidate the entry.
    const cached = apiKeyCache.get(rawKey);
    if (cached) {
      if (cached.expiresAt && new Date() >= cached.expiresAt) {
        throw new UnauthorizedException();
      }
      return cached.userId;
    }

    const slug = rawKey.slice(0, 6);
    const candidates = await this.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.slug, slug));

    for (const candidate of candidates) {
      const match = await comparePassword(rawKey, candidate.keyHash);
      if (!match) continue;

      if (candidate.expiresAt && new Date() >= candidate.expiresAt) {
        throw new UnauthorizedException();
      }

      apiKeyCache.set(rawKey, {
        keyId: candidate.id,
        userId: candidate.userId,
        expiresAt: candidate.expiresAt ?? null,
      });
      return candidate.userId;
    }

    throw new UnauthorizedException();
  }
}
