import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';

// Set env vars before any module is imported
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ?? 'test-secret-for-e2e';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';

export async function createTestApp(
  moduleFixture: TestingModule,
): Promise<INestApplication<App>> {
  const app = moduleFixture.createNestApplication<INestApplication<App>>({
    bodyParser: false,
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  await app.init();
  return app;
}
