import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';

@Controller('api/v1/api-keys')
@UseGuards(SessionAuthGuard)
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  private getUserId(req: Request): number {
    const user = req.user as { id: number };
    return user.id;
  }

  @Get()
  list(@Req() req: Request) {
    return this.apiKeysService.listByUser(this.getUserId(req));
  }

  @Post()
  @HttpCode(201)
  create(@Req() req: Request, @Body() dto: CreateApiKeyDto) {
    return this.apiKeysService.create(
      this.getUserId(req),
      dto.name,
      dto.expires_at,
    );
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateApiKeyDto,
  ) {
    if (dto.name === undefined && dto.expires_at === undefined) {
      throw new BadRequestException(
        'At least one of name or expires_at must be provided',
      );
    }
    return this.apiKeysService.update(id, this.getUserId(req), dto);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.apiKeysService.delete(id, this.getUserId(req));
  }
}
