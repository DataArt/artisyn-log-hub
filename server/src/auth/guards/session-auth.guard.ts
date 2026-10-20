import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  private readonly logger = new Logger(SessionAuthGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.isAuthenticated()) {
      return true;
    }

    const rawCookie = request.headers.cookie ?? '';
    const hasSidCookie = rawCookie.includes('connect.sid=');
    const sessionPassport = (
      request.session as unknown as Record<string, unknown>
    )['passport'] as { user?: number } | undefined;
    const storedUserId = sessionPassport?.user;

    // Distinguish three failure modes:
    //   no-cookie    → client never authenticated (or cookie was cleared)
    //   no-session   → SESSION_SECRET changed, session expired, or store race
    //   no-user      → session valid but user deleted from DB
    let reason: string;
    if (!hasSidCookie) {
      reason = 'no-cookie';
    } else if (storedUserId == null) {
      reason =
        'no-session (cookie present but not found in store — possible SECRET rotation or expiry)';
    } else {
      reason = `no-user (session had userId=${storedUserId} but deserializeUser returned null)`;
    }

    this.logger.debug(
      `Auth rejected [${reason}]: ${request.method} ${request.path}`,
    );

    throw new UnauthorizedException();
  }
}
