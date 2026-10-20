import type { ConfigService } from '@nestjs/config';

/**
 * The Azure (Entra ID) authority URL for Mode 4.
 *
 * `AZURE_AUTHORITY` wins when set and non-empty; otherwise the single-tenant
 * v2.0 authority for `AZURE_TENANT_ID` is used. Startup validation
 * (`validateMode4`) guarantees the tenant is a GUID and that an explicit
 * authority points at that same tenant.
 *
 * Shared by the MSAL client (`AzureAuthService`) and the public
 * `GET /api/v1/auth/config` response so the two can never disagree.
 */
export function resolveAzureAuthority(config: ConfigService): string {
  const explicit = config.get<string>('AZURE_AUTHORITY');
  if (explicit) return explicit;
  const tenantId = config.get<string>('AZURE_TENANT_ID', '');
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}
