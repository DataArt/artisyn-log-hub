import { Injectable, Logger } from '@nestjs/common';
import { PassportSerializer } from '@nestjs/passport';
import { UsersService } from '../users/users.service';

@Injectable()
export class SessionSerializer extends PassportSerializer {
  private readonly logger = new Logger(SessionSerializer.name);

  constructor(private readonly usersService: UsersService) {
    super();
  }

  serializeUser(
    user: { id: number },
    done: (err: unknown, id: number) => void,
  ) {
    done(null, user.id);
  }

  async deserializeUser(
    id: number,
    done: (err: unknown, user: unknown) => void,
  ) {
    try {
      const user = await this.usersService.findById(id);
      if (!user) {
        this.logger.warn(
          `Session references deleted user id=${id} — session will be invalidated`,
        );
      }
      done(null, user);
    } catch (err) {
      this.logger.error(
        `Failed to deserialize session for user id=${id}`,
        err instanceof Error ? err.stack : String(err),
      );
      done(err, null);
    }
  }
}
