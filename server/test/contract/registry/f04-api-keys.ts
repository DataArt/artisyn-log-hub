// F04 — API keys (docs/qaa-overview/scenarios/05 §F04). The plain key is only ever returned
// once; the DB keeps the 6-char slug and an argon2 hash.
import type { ContractFamily, ReadSpec } from '../types';

const LIST: Omit<ReadSpec, 'args'> = {
  sql: `SELECT id, name, slug, created_at, expires_at
          FROM api_keys WHERE user_id = $1 ORDER BY id`,
  shape: 'array',
  fields: {
    id: 'id',
    name: 'name',
    slug: 'slug',
    created_at: { col: 'created_at', as: 'iso' },
    expires_at: { col: 'expires_at', as: 'iso?' },
  },
  // No key_hash, no plain key.
  strict: true,
};

export const f04ApiKeys: ContractFamily = {
  id: 'F04',
  name: 'api-keys',
  cases: [
    {
      id: 'F04-list',
      route: 'GET /api/v1/api-keys',
      actor: 'owner',
      expect: { status: 200, minRows: 2 },
      read: { ...LIST, args: ['@owner.id'] },
    },
    {
      // Another user sees only their own key.
      id: 'F04-list-member',
      route: 'GET /api/v1/api-keys',
      actor: 'member',
      expect: { status: 200, minRows: 1 },
      read: { ...LIST, args: ['@member.id'] },
    },
    {
      id: 'F04-list-anon',
      route: 'GET /api/v1/api-keys',
      actor: 'anon',
      expect: { status: 401 },
    },
    {
      id: 'F04-create',
      route: 'POST /api/v1/api-keys',
      actor: 'owner',
      body: { name: 'upload-key' },
      expect: { status: 201, bodyMatches: { name: 'upload-key' } },
      write: {
        watch: ['api_keys'],
        delta: {
          inserted: [
            {
              table: 'api_keys',
              where: `user_id = @owner.id AND name = 'upload-key'`,
              check: [
                'id = $id',
                'slug = left($key, 6)',
                'slug = $slug',
                'expires_at IS NULL',
                'key_hash <> $key',
                'argon2verify(key_hash, $key)',
              ],
            },
          ],
        },
      },
    },
    {
      id: 'F04-rename',
      route: 'PATCH /api/v1/api-keys/:id',
      actor: 'owner',
      params: { id: '@ownerCiKey.id' },
      body: { name: 'owner-ci-key-renamed' },
      expect: { status: 200 },
      write: {
        watch: ['api_keys'],
        delta: {
          updated: [
            {
              table: 'api_keys',
              where: 'id = @ownerCiKey.id',
              changed: { name: 'owner-ci-key-renamed' },
            },
          ],
        },
      },
    },
    {
      id: 'F04-rename-foreign-key',
      route: 'PATCH /api/v1/api-keys/:id',
      actor: 'member',
      params: { id: '@ownerCiKey.id' },
      body: { name: 'stolen' },
      expect: { status: 403 },
    },
    {
      id: 'F04-rename-empty-body',
      route: 'PATCH /api/v1/api-keys/:id',
      actor: 'owner',
      params: { id: '@ownerCiKey.id' },
      body: {},
      expect: { status: 400 },
    },
    {
      id: 'F04-delete',
      route: 'DELETE /api/v1/api-keys/:id',
      actor: 'owner',
      params: { id: '@ownerCiKey.id' },
      expect: { status: 204 },
      write: {
        watch: ['api_keys'],
        delta: {
          deleted: [{ table: 'api_keys', where: 'id = @ownerCiKey.id' }],
        },
      },
    },
    {
      id: 'F04-delete-foreign-key',
      route: 'DELETE /api/v1/api-keys/:id',
      actor: 'outsider',
      params: { id: '@memberKey.id' },
      expect: { status: 403 },
    },
  ],
};
