import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import * as schema from '../../database/schema';

@Injectable()
export class AdminOrTeamOwnerGuard implements CanActivate {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as { id: number; role: string } | undefined;

    if (!user) {
      throw new ForbiddenException();
    }

    if (user.role === 'admin') {
      return true;
    }

    const teams = await this.db
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.ownerId, user.id))
      .limit(1);

    if (teams.length > 0) {
      return true;
    }

    throw new ForbiddenException();
  }
}
