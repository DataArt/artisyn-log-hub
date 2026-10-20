import { AuthenticationResult } from '@azure/msal-node';
import {
  Controller,
  Get,
  Logger,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { UsersService } from '../../users/users.service';
import { AllowedAuthModes, AuthModeGuard } from '../guards/auth-mode.guard';
import { AzureAuthService } from './azure-auth.service';

/**
 * Lives outside the api/v1/auth prefix on purpose: /api/auth/callback is the
 * redirect URI that existing Azure App Registrations already have configured,
 * so moving it under /api/v1/auth would force every deployment to update its
 * registration in the Azure Portal.
 */
@Controller('api/auth')
export class AzureCallbackController {
  private readonly logger = new Logger(AzureCallbackController.name);

  constructor(
    private readonly azureAuthService: AzureAuthService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  @Get('callback')
  @AllowedAuthModes('azure-oauth')
  @UseGuards(AuthModeGuard)
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('error_description') errorDescription?: string,
  ): Promise<void> {
    const session = req.session as unknown as Record<string, unknown>;
    const expectedState = session['oauthState'] as string | undefined;
    const expectedNonce = session['oauthNonce'] as string | undefined;
    delete session['oauthState'];
    delete session['oauthNonce'];

    const fail = (detail: string, reason: 'tenant' | '1' = '1'): void => {
      // Only a coarse reason code reaches the client ('tenant' for a sign-in
      // from another directory, '1' for everything else) — provider and
      // validation detail is logged server-side, never leaked in the redirect.
      this.logger.warn(`Azure OAuth callback failed: ${detail}`);
      res.redirect(`/#/login?oauthError=${reason}`);
    };

    if (error) {
      return fail(`provider error: ${error} ${errorDescription ?? ''}`);
    }
    if (!code || !state || !expectedState || state !== expectedState) {
      return fail('missing code or state/nonce validation failure');
    }

    let result: AuthenticationResult | null;
    try {
      result = await this.azureAuthService.acquireTokenByCode(code, state);
    } catch (err) {
      this.logger.error('Azure token exchange failed', err as Error);
      return fail('token exchange error');
    }
    if (!result) {
      return fail('empty token result');
    }

    const claims = result.idTokenClaims as Record<string, unknown>;
    if (claims['nonce'] !== expectedNonce) {
      return fail('nonce mismatch');
    }

    // Single-tenant only: an ID token issued by any other directory (or one
    // with no tid at all) is refused, even if MSAL accepted it.
    const expectedTenant = this.configService
      .get<string>('AZURE_TENANT_ID', '')
      .toLowerCase();
    const tid = claims['tid'];
    if (
      typeof tid !== 'string' ||
      !expectedTenant ||
      tid.toLowerCase() !== expectedTenant
    ) {
      return fail(
        `tenant mismatch (tid=${typeof tid === 'string' ? tid : 'missing'})`,
        'tenant',
      );
    }

    const email =
      (claims['email'] as string | undefined) ||
      (claims['preferred_username'] as string | undefined);
    if (!email) {
      return fail('no email or preferred_username claim on ID token');
    }

    const user = await this.usersService.findOrCreateAutoProvisioned(email);
    await this.usersService.acceptGrantedInvitations(user.id);
    await new Promise<void>((resolve, reject) =>
      req.logIn(user, (err) => (err ? reject(err as Error) : resolve())),
    );
    res.redirect('/');
  }
}
