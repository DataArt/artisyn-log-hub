import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

export const AUTH_MODES_KEY = 'authModes';

/**
 * Marks a route as active only under the listed AUTH_MODE value(s). Any other
 * mode 404s the route (not 403 — to avoid confirming the route exists at all).
 */
export const AllowedAuthModes = (...modes: string[]) =>
  SetMetadata(AUTH_MODES_KEY, modes);

@Injectable()
export class AuthModeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedModes = this.reflector.get<string[] | undefined>(
      AUTH_MODES_KEY,
      context.getHandler(),
    );
    if (!allowedModes) return true;

    const activeMode = this.configService.get<string>('AUTH_MODE');
    if (!activeMode || !allowedModes.includes(activeMode)) {
      throw new NotFoundException();
    }
    return true;
  }
}
