// F05 — per-user settings (docs/qaa-overview/scenarios/05 §F05). Table `user_settings`,
// PK (user_id, setting_name).
import type { ContractFamily } from '../types';

export const f05UserSettings: ContractFamily = {
  id: 'F05',
  name: 'user-settings',
  cases: [
    {
      id: 'F05-list',
      route: 'GET /api/v1/user-settings',
      actor: 'owner',
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `SELECT setting_name, setting_value FROM user_settings WHERE user_id = $1`,
        args: ['@owner.id'],
        shape: 'array',
        sortBy: 'name',
        fields: { name: 'setting_name', value: 'setting_value' },
        strict: true,
      },
    },
    {
      id: 'F05-get',
      route: 'GET /api/v1/user-settings/:name',
      actor: 'member',
      params: { name: 'theme' },
      expect: { status: 200 },
      read: {
        sql: `SELECT setting_name, setting_value FROM user_settings
               WHERE user_id = $1 AND setting_name = 'theme'`,
        args: ['@member.id'],
        shape: 'object',
        fields: { name: 'setting_name', value: 'setting_value' },
        strict: true,
      },
    },
    {
      // An unset setting is not a 404: the answer is the name with value null (current code;
      // 05 §F05 assumed 404).
      id: 'F05-get-missing',
      route: 'GET /api/v1/user-settings/:name',
      actor: 'member',
      params: { name: 'viewer.density' },
      expect: {
        status: 200,
        bodyMatches: { name: 'viewer.density', value: null },
      },
      noDb: true,
    },
    {
      id: 'F05-get-bad-name',
      route: 'GET /api/v1/user-settings/:name',
      actor: 'owner',
      params: { name: 'bad name!' },
      expect: { status: 400 },
    },
    {
      id: 'F05-put-existing',
      route: 'PUT /api/v1/user-settings/:name',
      actor: 'owner',
      params: { name: 'theme' },
      body: { value: 'sand' },
      expect: { status: 200 },
      write: {
        watch: ['user_settings'],
        delta: {
          updated: [
            {
              table: 'user_settings',
              where: `user_id = @owner.id AND setting_name = 'theme'`,
              changed: { setting_value: 'sand' },
            },
          ],
        },
      },
    },
    {
      id: 'F05-put-new',
      route: 'PUT /api/v1/user-settings/:name',
      actor: 'member',
      params: { name: 'viewer.density' },
      body: { value: 'roomy' },
      expect: { status: 200 },
      write: {
        watch: ['user_settings'],
        delta: {
          inserted: [
            {
              table: 'user_settings',
              where: `user_id = @member.id AND setting_name = 'viewer.density'`,
              check: [`setting_value = 'roomy'`],
            },
          ],
        },
      },
    },
    {
      id: 'F05-delete',
      route: 'DELETE /api/v1/user-settings/:name',
      actor: 'owner',
      params: { name: 'viewer.density' },
      expect: { status: 204 },
      write: {
        watch: ['user_settings'],
        delta: {
          deleted: [
            {
              table: 'user_settings',
              where: `user_id = @owner.id AND setting_name = 'viewer.density'`,
            },
          ],
        },
      },
    },
  ],
};
