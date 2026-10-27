import {
  AuthenticationResult,
  ConfidentialClientApplication,
} from '@azure/msal-node';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveAzureAuthority } from './azure-authority';

/**
 * Thin wrapper around @azure/msal-node's Authorization Code flow (Mode 4).
 * `passport-azure-ad` and `passport-openidconnect` are explicitly rejected by
 * requirements.md (deprecated/unmaintained) in favor of using MSAL directly.
 *
 * The MSAL client is built lazily, on first actual use — not in the
 * constructor — because AuthModule provides this service unconditionally
 * regardless of the active AUTH_MODE, and AZURE_* env vars are only
 * guaranteed present (by auth-startup-validation.ts) when Mode 4 is active.
 * Constructing eagerly with empty/missing values could break every other
 * mode's startup.
 */
@Injectable()
export class AzureAuthService {
  private cca: ConfidentialClientApplication | undefined;

  constructor(private readonly configService: ConfigService) {}

  private getClient(): ConfidentialClientApplication {
    if (!this.cca) {
      this.cca = new ConfidentialClientApplication({
        auth: {
          clientId: this.configService.get<string>('AZURE_CLIENT_ID', ''),
          clientSecret: this.configService.get<string>(
            'AZURE_CLIENT_SECRET',
            '',
          ),
          authority: resolveAzureAuthority(this.configService),
        },
      });
    }
    return this.cca;
  }

  private getScopes(): string[] {
    return this.configService
      .get<string>('AZURE_SCOPES', 'openid profile email')
      .split(' ')
      .filter(Boolean);
  }

  private getRedirectUri(): string {
    return this.configService.get<string>('AZURE_REDIRECT_URI', '');
  }

  getAuthCodeUrl(state: string, nonce: string): Promise<string> {
    return this.getClient().getAuthCodeUrl({
      scopes: this.getScopes(),
      redirectUri: this.getRedirectUri(),
      state,
      nonce,
    });
  }

  /**
   * `nonce` is the value sent with getAuthCodeUrl. msal-node 7 rejects an ID
   * token that carries a nonce (`nonce_mismatch`) unless the expected one is
   * passed here, so the exchange cannot succeed without it.
   */
  acquireTokenByCode(
    code: string,
    state: string,
    nonce: string,
  ): Promise<AuthenticationResult | null> {
    return this.getClient().acquireTokenByCode({
      scopes: this.getScopes(),
      redirectUri: this.getRedirectUri(),
      code,
      state,
      nonce,
    });
  }
}
