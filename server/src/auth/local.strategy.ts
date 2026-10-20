import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Strategy } from 'passport-local';
import { AuthService } from './auth.service';
import { LoginBackoffService } from './login-backoff.service';
import { maskEmail } from '../common/mask-email';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  // Security event log. Masked email + source IP only — the submitted
  // password never reaches a log line, here or anywhere else.
  private readonly logger = new Logger(LocalStrategy.name);

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly loginBackoff: LoginBackoffService,
  ) {
    // passReqToCallback prepends the request to validate()'s arguments — the
    // brute-force delay is tracked per source IP as well as per account.
    super({ usernameField: 'email', passReqToCallback: true });
  }

  async validate(req: Request, email: string, password: string) {
    // `req.ip` is only trustworthy behind a proxy when TRUST_PROXY is set
    // (see common/trust-proxy.ts); without it Express reports the socket peer,
    // which is what `remoteAddress` falls back to anyway.
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    try {
      await this.loginBackoff.assertNotDelayed(email, ip);
    } catch (err) {
      this.logger.warn(
        `Login rejected while a brute-force delay is active: email=${maskEmail(email)} ip=${ip}`,
      );
      throw err;
    }

    const user = await this.authService.validateUser(email, password);
    if (!user) {
      const delaySeconds = await this.loginBackoff.recordFailure(email, ip);
      this.logger.warn(`Login failed: email=${maskEmail(email)} ip=${ip}`);
      if (delaySeconds > 0) {
        this.logger.warn(
          `Login delay applied: email=${maskEmail(email)} ip=${ip} seconds=${delaySeconds}`,
        );
      }
      throw new UnauthorizedException();
    }

    // The credential itself was correct, so the account's failure streak is
    // over — reset it before the confirmation check, which can still reject
    // this request without it being a failed *password* attempt.
    await this.loginBackoff.recordSuccess(email);

    if (
      this.configService.get<string>('AUTH_MODE') === 'password-confirm' &&
      !user.emailConfirmedAt
    ) {
      this.logger.warn(
        `Login rejected, email not confirmed: email=${maskEmail(email)} ip=${ip} userId=${user.id}`,
      );
      throw new ForbiddenException({ error: 'email_not_confirmed' });
    }
    this.logger.log(
      `Login succeeded: email=${maskEmail(email)} ip=${ip} userId=${user.id}`,
    );
    return user;
  }
}
