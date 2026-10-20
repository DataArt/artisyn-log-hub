import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import * as schema from '../../database/schema';

@Injectable()
export class TeamOwnerOrAdminGuard implements CanActivate {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as { id: number; role: string } | undefined;
    const teamId = Number((request.params as Record<string, string>)['teamId']);

    const teams = await this.db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    const team = teams[0];
    if (!team) {
      throw new NotFoundException('Team not found');
    }

    (request as Request & { team: typeof team }).team = team;

    if (!user) {
      throw new ForbiddenException();
    }

    if (user.id === team.ownerId || user.role === 'admin') {
      return true;
    }

    throw new ForbiddenException();
  }
}
