import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuthService } from '../auth.service';
import { isLocalhostRequest } from '../utils/localhost.util';

/**
 * Mode 1 (no auth) convenience: when an unauthenticated localhost request has
 * no session, silently log it in instead of forcing the manual identify step
 * — see AuthService.autoIdentifyMode1() for the user-selection rule. A no-op
 * for every other mode, for non-localhost requests, and for already
 * authenticated requests, so it never widens Mode 1's own security model
 * (identify() is already localhost-only).
 */
@Injectable()
export class AutoIdentifyGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.isAuthenticated()) return true;
    if (this.configService.get<string>('AUTH_MODE') !== 'none') return true;
    if (!isLocalhostRequest(req)) return true;

    const user = await this.authService.autoIdentifyMode1();
    if (!user) return true;

    await new Promise<void>((resolve, reject) =>
      req.logIn(user, (err) => (err ? reject(err as Error) : resolve())),
    );
    return true;
  }
}
