// F22 — model pricing and AI tool versions (docs/qaa-overview/scenarios/05 §F22), plus the admin
// pricing API (`/api/v1/admin/model-pricing`, added after 05 was written).
//
// World: world-model-a has three versions (2025, 2026 — current — and 2099, never in effect);
// world-model-b has no chars_per_token/context length; world-model-fetched is a fetched
// (anthropic) price; world-model-overridden carries an admin override over a fetched base;
// world-model-unpriced has no price at all.
import type { ContractFamily } from '../types';

/** The newest price version of each model in effect today. */
const CURRENT_PRICES = `
  SELECT DISTINCT ON (model_id) *
    FROM model_pricing
   WHERE effective_from <= current_date
   ORDER BY model_id, effective_from DESC`;

/** jsonb of one price row's rates, as the API spells them. */
const RATES_JSON = `jsonb_build_object(
  'priceIn', cp.price_in::float8, 'priceOut', cp.price_out::float8,
  'priceCacheR', cp.price_cache_r::float8, 'priceCacheW5m', cp.price_cache_w_5m::float8,
  'priceCacheW1h', cp.price_cache_w_1h::float8, 'priceWebSearch', cp.price_web_search::float8,
  'charsPerToken', cp.chars_per_token::float8, 'contextLength', cp.context_length)`;

export const f22PricingToolVersions: ContractFamily = {
  id: 'F22',
  name: 'pricing-tool-versions',
  cases: [
    {
      id: 'F22-public-pricing',
      route: 'GET /api/v1/model-pricing',
      actor: 'anon',
      expect: { status: 200, minRows: 4 },
      read: {
        // `tiers` only for a model that has them (DD12): untiered entries stay byte-identical.
        sql: `SELECT cp.model_id,
                     ${RATES_JSON} || CASE WHEN cp.tiers IS NULL THEN '{}'::jsonb
                                           ELSE jsonb_build_object('tiers', cp.tiers) END AS rates
                FROM (${CURRENT_PRICES}) cp`,
        shape: 'map',
        mapKey: 'model_id',
        mapValue: { col: 'rates', as: 'json' },
      },
    },
    {
      // The resolved state of every priced model: an override shows its base's source plus the
      // hidden base rates.
      id: 'F22-admin-list',
      route: 'GET /api/v1/admin/model-pricing',
      actor: 'admin',
      expect: { status: 200, minRows: 4 },
      read: {
        sql: `SELECT cp.model_id,
                     CASE WHEN cp.source = 'override' THEN m.override_base_source ELSE cp.source END
                       AS source,
                     cp.source = 'override' AS override_active,
                     ${RATES_JSON} || jsonb_build_object('effectiveFrom', cp.effective_from::text,
                                                         'tiers', cp.tiers)
                       AS effective,
                     CASE WHEN cp.source = 'override' THEN jsonb_build_object(
                       'priceIn', m.override_base_price_in::float8,
                       'priceOut', m.override_base_price_out::float8,
                       'priceCacheR', m.override_base_price_cache_r::float8,
                       'priceCacheW5m', m.override_base_price_cache_w_5m::float8,
                       'priceCacheW1h', m.override_base_price_cache_w_1h::float8,
                       'priceWebSearch', m.override_base_price_web_search::float8,
                       'charsPerToken', m.override_base_chars_per_token::float8,
                       'contextLength', m.override_base_context_length,
                       'tiers', m.override_base_tiers) END AS base,
                     m.first_seen_at
                FROM (${CURRENT_PRICES}) cp
                LEFT JOIN model_pricing_meta m ON m.model_id = cp.model_id`,
        shape: 'array',
        path: 'models',
        sortBy: 'modelId',
        fields: {
          modelId: 'model_id',
          source: 'source',
          overrideActive: 'override_active',
          effective: { col: 'effective', as: 'json' },
          base: { col: 'base', as: 'json' },
          firstSeenAt: { col: 'first_seen_at', as: 'iso?' },
        },
        strict: true,
      },
    },
    {
      id: 'F22-admin-list-member',
      route: 'GET /api/v1/admin/model-pricing',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      // A manual price is replaced by a new manual version effective today; omitted cache rates
      // default from priceIn (5m x1.25, 1h x2), cache read and web search to 0.
      id: 'F22-set-price',
      route: 'PUT /api/v1/admin/model-pricing/price',
      actor: 'admin',
      body: { modelId: '@models.b', priceIn: 4, priceOut: 8 },
      expect: {
        status: 200,
        bodyMatches: { modelId: 'world-model-b', source: 'manual' },
      },
      write: {
        watch: ['model_pricing', 'model_pricing_meta'],
        derived: ['session_costs'],
        delta: {
          inserted: [
            {
              table: 'model_pricing',
              where: `model_id = 'world-model-b' AND effective_from = current_date`,
              check: [
                'price_in = 4',
                'price_out = 8',
                'price_cache_w_5m = 5',
                'price_cache_w_1h = 8',
                'price_cache_r = 0',
                `source = 'manual'`,
              ],
            },
          ],
        },
      },
    },
    {
      id: 'F22-set-price-on-fetched',
      route: 'PUT /api/v1/admin/model-pricing/price',
      actor: 'admin',
      body: { modelId: '@models.fetched', priceIn: 4, priceOut: 8 },
      expect: { status: 409 },
    },
    {
      id: 'F22-set-price-member',
      route: 'PUT /api/v1/admin/model-pricing/price',
      actor: 'member',
      body: { modelId: '@models.b', priceIn: 4, priceOut: 8 },
      expect: { status: 403 },
    },
    {
      // A manual price with one prompt-length tier: the tier is stored on the new version.
      id: 'F22-set-price-tiers',
      route: 'PUT /api/v1/admin/model-pricing/price',
      actor: 'admin',
      body: {
        modelId: '@models.b',
        priceIn: 4,
        priceOut: 8,
        tiers: [
          {
            aboveTokens: 200000,
            priceIn: 8,
            priceOut: 16,
            priceCacheR: 0.8,
            priceCacheW5m: 10,
            priceCacheW1h: 16,
          },
        ],
      },
      expect: {
        status: 200,
        bodyMatches: { modelId: 'world-model-b', source: 'manual' },
      },
      write: {
        watch: ['model_pricing', 'model_pricing_meta'],
        derived: ['session_costs'],
        delta: {
          inserted: [
            {
              table: 'model_pricing',
              where: `model_id = 'world-model-b' AND effective_from = current_date`,
              check: [
                'price_in = 4',
                'price_out = 8',
                `source = 'manual'`,
                `tiers = '[{"aboveTokens": 200000, "priceIn": 8, "priceOut": 16, "priceCacheR": 0.8, "priceCacheW5m": 10, "priceCacheW1h": 16}]'::jsonb`,
              ],
            },
          ],
        },
      },
    },
    {
      // Thresholds must be strictly increasing in the order given; nothing is written.
      id: 'F22-set-price-tiers-nonincreasing',
      route: 'PUT /api/v1/admin/model-pricing/price',
      actor: 'admin',
      body: {
        modelId: '@models.b',
        priceIn: 4,
        priceOut: 8,
        tiers: [
          {
            aboveTokens: 200000,
            priceIn: 8,
            priceOut: 16,
            priceCacheR: 0.8,
            priceCacheW5m: 10,
            priceCacheW1h: 16,
          },
          {
            aboveTokens: 100000,
            priceIn: 6,
            priceOut: 12,
            priceCacheR: 0.6,
            priceCacheW5m: 7.5,
            priceCacheW1h: 12,
          },
        ],
      },
      expect: { status: 400 },
    },
    {
      id: 'F22-set-price-tiers-bad-rate',
      route: 'PUT /api/v1/admin/model-pricing/price',
      actor: 'admin',
      body: {
        modelId: '@models.b',
        priceIn: 4,
        priceOut: 8,
        tiers: [
          {
            aboveTokens: 200000,
            priceIn: -1,
            priceOut: 16,
            priceCacheR: 0.8,
            priceCacheW5m: 10,
            priceCacheW1h: 16,
          },
        ],
      },
      expect: { status: 400 },
    },
    {
      // Overriding a fetched price: the effective version becomes an `override` and the fetched
      // rates are kept aside as the override base.
      id: 'F22-override',
      route: 'PUT /api/v1/admin/model-pricing/override',
      actor: 'admin',
      body: { modelId: '@models.fetched', priceIn: 1, priceOut: 5 },
      expect: {
        status: 200,
        bodyMatches: { modelId: 'world-model-fetched', overrideActive: true },
      },
      write: {
        watch: ['model_pricing', 'model_pricing_meta'],
        derived: ['session_costs'],
        delta: {
          inserted: [
            {
              table: 'model_pricing',
              where: `model_id = 'world-model-fetched' AND effective_from = current_date`,
              check: ['price_in = 1', 'price_out = 5', `source = 'override'`],
            },
            {
              table: 'model_pricing_meta',
              where: `model_id = 'world-model-fetched'`,
              check: [
                `override_base_source = 'anthropic'`,
                'override_base_price_in = 3',
                'override_base_price_out = 15',
              ],
            },
          ],
        },
      },
    },
    {
      id: 'F22-override-manual',
      route: 'PUT /api/v1/admin/model-pricing/override',
      actor: 'admin',
      body: { modelId: '@models.a', priceIn: 1, priceOut: 5 },
      expect: { status: 409 },
    },
    {
      id: 'F22-override-member',
      route: 'PUT /api/v1/admin/model-pricing/override',
      actor: 'member',
      body: { modelId: '@models.fetched', priceIn: 1, priceOut: 5 },
      expect: { status: 403 },
    },
    {
      // An override with tiers: the override version carries them, while the stored base keeps
      // the fetched price's own (absent) tiers.
      id: 'F22-override-tiers',
      route: 'PUT /api/v1/admin/model-pricing/override',
      actor: 'admin',
      body: {
        modelId: '@models.fetched',
        priceIn: 1,
        priceOut: 5,
        tiers: [
          {
            aboveTokens: 200000,
            priceIn: 8,
            priceOut: 16,
            priceCacheR: 0.8,
            priceCacheW5m: 10,
            priceCacheW1h: 16,
          },
        ],
      },
      expect: {
        status: 200,
        bodyMatches: { modelId: 'world-model-fetched', overrideActive: true },
      },
      write: {
        watch: ['model_pricing', 'model_pricing_meta'],
        derived: ['session_costs'],
        delta: {
          inserted: [
            {
              table: 'model_pricing',
              where: `model_id = 'world-model-fetched' AND effective_from = current_date`,
              check: [
                'price_in = 1',
                'price_out = 5',
                `source = 'override'`,
                `tiers = '[{"aboveTokens": 200000, "priceIn": 8, "priceOut": 16, "priceCacheR": 0.8, "priceCacheW5m": 10, "priceCacheW1h": 16}]'::jsonb`,
              ],
            },
            {
              table: 'model_pricing_meta',
              where: `model_id = 'world-model-fetched'`,
              check: [
                `override_base_source = 'anthropic'`,
                'override_base_price_in = 3',
                'override_base_tiers IS NULL',
              ],
            },
          ],
        },
      },
    },
    {
      // Clearing restores the base as a new effective version and drops the stored base.
      id: 'F22-clear-override',
      route: 'POST /api/v1/admin/model-pricing/override/clear',
      actor: 'admin',
      body: { modelId: '@models.overridden' },
      expect: {
        status: 200,
        bodyMatches: {
          modelId: 'world-model-overridden',
          overrideActive: false,
        },
      },
      write: {
        watch: ['model_pricing', 'model_pricing_meta'],
        derived: ['session_costs'],
        delta: {
          inserted: [
            {
              table: 'model_pricing',
              where: `model_id = 'world-model-overridden' AND effective_from = current_date`,
              check: ['price_in = 3', 'price_out = 15', `source = 'anthropic'`],
            },
          ],
          updated: [
            {
              table: 'model_pricing_meta',
              where: `model_id = 'world-model-overridden'`,
              changed: {
                override_base_source: null,
                override_base_price_in: null,
                override_base_price_out: null,
                override_base_price_cache_r: null,
                override_base_price_cache_w_5m: null,
                override_base_price_cache_w_1h: null,
                override_base_price_web_search: null,
              },
              anyChange: ['updated_at'],
            },
          ],
        },
      },
    },
    {
      id: 'F22-clear-override-none-active',
      route: 'POST /api/v1/admin/model-pricing/override/clear',
      actor: 'admin',
      body: { modelId: '@models.fetched' },
      expect: { status: 409 },
    },
    {
      id: 'F22-clear-override-unknown',
      route: 'POST /api/v1/admin/model-pricing/override/clear',
      actor: 'admin',
      body: { modelId: 'world-model-nonexistent' },
      expect: { status: 404 },
    },
    {
      // The positive import calls the OpenRouter catalogue over the network; only the guard is
      // exercised here (05 §5 risk 1: external services).
      id: 'F22-import-openrouter-member',
      route: 'POST /api/v1/admin/model-pricing/import-openrouter',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      // "Fetch now" downloads the Anthropic pricing page; like the OpenRouter import, only the
      // guard is exercised here (05 §5 risk 1: external services).
      id: 'F22-fetch-anthropic-member',
      route: 'POST /api/v1/admin/model-pricing/fetch-anthropic',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      id: 'F22-tool-version',
      route: 'GET /api/v1/ai-tool-versions/:toolName',
      actor: 'owner',
      params: { toolName: 'claude-code' },
      expect: { status: 200 },
      read: {
        sql: `SELECT tool_name, fetched_at FROM ai_tool_version WHERE tool_name = 'claude-code'`,
        shape: 'object',
        fields: {
          toolName: 'tool_name',
          fetchedAt: { col: 'fetched_at', as: 'iso?' },
        },
        ignore: ['history'],
        strict: true,
      },
    },
    {
      id: 'F22-tool-version-history',
      route: 'GET /api/v1/ai-tool-versions/:toolName',
      actor: 'owner',
      params: { toolName: 'claude-code' },
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `SELECT version_map, effective_from FROM ai_tool_version_history
               WHERE tool_name = 'claude-code' ORDER BY effective_from`,
        shape: 'array',
        path: 'history',
        fields: {
          versions: { col: 'version_map', as: 'json' },
          effectiveFrom: { col: 'effective_from', as: 'iso' },
        },
        strict: true,
      },
    },
    {
      id: 'F22-tool-version-unknown',
      route: 'GET /api/v1/ai-tool-versions/:toolName',
      actor: 'owner',
      params: { toolName: 'no-such-tool' },
      expect: { status: 404 },
    },
    {
      id: 'F22-tool-version-anon',
      route: 'GET /api/v1/ai-tool-versions/:toolName',
      actor: 'anon',
      params: { toolName: 'claude-code' },
      expect: { status: 401 },
    },
  ],
};
