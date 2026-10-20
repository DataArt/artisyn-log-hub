/**
 * Only ever set by a test run — the contract suite's global setup
 * (`contract_<uuid>`) or the scenario stand (`scn_*`) — to a schema unique to
 * that run, isolating its app from the always-on dev server, which keeps using
 * the default `public` schema. Unset in production/dev, so this is a no-op
 * there.
 */
export function resolveSearchPathOption(): string | undefined {
  const schema = process.env.E2E_DB_SCHEMA;
  return schema ? `-c search_path=${schema},public` : undefined;
}
