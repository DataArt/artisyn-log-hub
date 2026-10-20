import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

type AuthUser = { id: number; role: string };

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthUser | undefined;
    if (user?.role === 'admin') {
      return true;
    }
    throw new ForbiddenException();
  }
}
