import {
  BeforeApplicationShutdown,
  Inject,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnApplicationBootstrap,
} from '@nestjs/common';
import * as fs from 'fs';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AdminModule } from './admin/admin.module';
import { AiToolVersionsModule } from './ai-tool-versions/ai-tool-versions.module';
import { ModelPricingModule } from './model-pricing/model-pricing.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AuthModule } from './auth/auth.module';
import { validateAuthStartupConfig } from './auth/config/auth-startup-validation';
import {
  GLOBAL_BODY_LIMIT,
  HOOK_API_BODY_LIMIT,
  HOOK_API_ROUTES,
  LOG_INGEST_ROUTES,
} from './common/body-limits';
import { throwMiddlewareErrors } from './common/middleware-errors';
import { precompressedCacheHeaders } from './common/precompressed-static';
import { securityHeaders } from './common/security-headers';
import { parseTrustProxy } from './common/trust-proxy';
import { PG_POOL } from './database/database.constants';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { InstallerModule } from './installer/installer.module';
import { inflateSniffedGzip } from './logs/gzip-sniff.middleware';
import { LogsModule } from './logs/logs.module';
import { PostTurnAnalysisModule } from './logs/post-turn-analysis/post-turn-analysis.module';
import { RequestMetricsMiddleware } from './system-info/request-metrics.middleware';
import { SessionsModule } from './sessions/sessions.module';
import { SystemInfoModule } from './system-info/system-info.module';
import { TeamsModule } from './teams/teams.module';
import { UsersModule } from './users/users.module';
import { UserSettingsModule } from './user-settings/user-settings.module';
import connectPgSimple from 'connect-pg-simple';
import { config as dotenvConfig } from 'dotenv';
import session from 'express-session';
import passport from 'passport';
import * as express from 'express';
import { join, resolve } from 'path';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { requestContextStorage } from './common/request-context';

dotenvConfig(); // load .env before the guard below — ConfigModule runs later

// Local, un-committed overrides (e.g. developer-specific SMTP/Azure secrets).
// Resolved via __dirname (server/src → server/.env.local), not cwd, so behavior
// doesn't depend on where the process happens to be launched from.
const envLocalPath = resolve(__dirname, '..', '.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenvConfig({ path: envLocalPath, override: true });
}

if (process.env.NODE_ENV !== 'test') {
  validateAuthStartupConfig();
}

/**
 * SESSION_SECRET guard. Runs from `configure()`, i.e. after
 * `initializeDatabase()` has resolved the secret (env → stored → generated).
 * The `test-secret-for-e2e` fallback only covers test apps built without
 * `initializeDatabase()` (`test/helpers/create-app.helper.ts`).
 */
function requireSessionSecret(): string {
  if (!process.env.SESSION_SECRET) {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        'SESSION_SECRET is not set — initializeDatabase() must run before the app is created',
      );
    }
    process.env.SESSION_SECRET = 'test-secret-for-e2e';
  }
  return process.env.SESSION_SECRET;
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, 'public'),
      serveRoot: '/',
      exclude: [
        '/api{/*path}',
        '/health{/*path}',
        '/static/artisyn-hooks-installer.tgz',
      ],
      // Content-hashed `assets/` output only — index.html, /favicon.svg and
      // /help/*.md keep revalidating. Runs before send's own
      // Content-Type/Cache-Control defaults, which both no-op once the header
      // is already set. See common/precompressed-static.ts.
      serveStaticOptions: { setHeaders: precompressedCacheHeaders },
    }),
    DatabaseModule,
    HealthModule,
    UsersModule,
    AuthModule,
    ApiKeysModule,
    LogsModule,
    PostTurnAnalysisModule,
    SessionsModule,
    TeamsModule,
    AdminModule,
    SystemInfoModule,
    InstallerModule,
    UserSettingsModule,
    AiToolVersionsModule,
    ModelPricingModule,
  ],
})
export class AppModule
  implements NestModule, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private pgStore: { close(): void | Promise<void> } | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async beforeApplicationShutdown(): Promise<void> {
    // Clear connect-pg-simple's prune timer before the DB pool is ended.
    // Without this, the timer keeps firing against the already-closed pool.
    await this.pgStore?.close();
  }

  onApplicationBootstrap() {
    // In dev mode the hook version.json exists; regenerate installer-version.json so
    // a version bump in hook/ is picked up without a full build-hooks-installer run.
    const hookVersionPath = resolve(
      __dirname,
      '..',
      '..',
      'hook',
      '.claude',
      'telemetry_tool',
      'version.json',
    );
    if (!fs.existsSync(hookVersionPath)) return;
    try {
      const { version } = JSON.parse(
        fs.readFileSync(hookVersionPath, 'utf8'),
      ) as { version: string };
      const staticDir = join(__dirname, 'public', 'static');
      fs.mkdirSync(staticDir, { recursive: true });
      fs.writeFileSync(
        join(staticDir, 'installer-version.json'),
        JSON.stringify({ version }) + '\n',
        'utf8',
      );
    } catch {
      /* non-fatal — static file may not be writable in prod */
    }
  }

  configure(consumer: MiddlewareConsumer) {
    // Must run on every request regardless of auth outcome, so it observes
    // real traffic across all routes, not just /admin/*.
    consumer.apply(RequestMetricsMiddleware).forRoutes('*');

    consumer
      .apply(
        (
          req: express.Request,
          _res: express.Response,
          next: express.NextFunction,
        ) => {
          requestContextStorage.run(
            {
              callUuid: randomUUID(),
              endpoint: req.originalUrl.split('?')[0],
            },
            next,
          );
        },
      )
      .forRoutes('*');

    const PgSession = connectPgSimple(session);
    const store = new PgSession({
      pool: this.pool,
      tableName: 'auth_sessions',
      createTableIfMissing: true,
    });
    this.pgStore = store;

    // First position: headers must be attached even when a later middleware or
    // guard short-circuits the request (401s, body-parser errors).
    consumer.apply(securityHeaders).forRoutes('*');

    // TRUST_PROXY wins over COOKIE_SECURE when enabled: behind a reverse proxy the
    // cookie's secure flag is derived per-request from X-Forwarded-Proto
    // (`secure: 'auto'` + `proxy: true`) instead of a static env value. Off by
    // default, where the expression below stays exactly what it always was.
    const behindProxy = parseTrustProxy(process.env.TRUST_PROXY) !== false;

    // Session/passport errors (e.g. the pg session store failing) go through
    // throwMiddlewareErrors so they are not rewritten to 404 — see that helper.
    consumer
      .apply(
        throwMiddlewareErrors(
          session({
            store,
            secret: requireSessionSecret(),
            resave: false,
            saveUninitialized: false,
            rolling: true,
            ...(behindProxy ? { proxy: true } : {}),
            cookie: {
              httpOnly: true,
              secure: behindProxy
                ? 'auto'
                : process.env.COOKIE_SECURE?.toLowerCase() !== 'false',
              sameSite: 'lax',
              maxAge: 3_600_000,
            },
          }),
        ),
        throwMiddlewareErrors(passport.initialize()),
        throwMiddlewareErrors(passport.session()),
      )
      .forRoutes('*');

    // Must precede the log-route body parsers registered by LogsModule (root-module
    // middleware is registered first): a gzip body whose Content-Encoding was stripped by
    // a proxy has to be inflated before it gets utf8-decoded.
    consumer
      .apply(throwMiddlewareErrors(inflateSniffedGzip))
      .forRoutes(...LOG_INGEST_ROUTES);

    // Body limits. The log-ingest routes parse at
    // `getLogsBodyLimit()` in LogsModule; the hook's JSON APIs get HOOK_API_BODY_LIMIT;
    // everything else gets GLOBAL_BODY_LIMIT. Oversize bodies are answered with 413,
    // malformed ones with 400 — via throwMiddlewareErrors, which keeps serve-static's
    // error handler from rewriting either to 404.
    consumer
      .apply(
        throwMiddlewareErrors(express.json({ limit: HOOK_API_BODY_LIMIT })),
        throwMiddlewareErrors(
          express.urlencoded({ extended: true, limit: HOOK_API_BODY_LIMIT }),
        ),
        throwMiddlewareErrors(
          express.text({
            type: 'application/x-ndjson',
            limit: HOOK_API_BODY_LIMIT,
          }),
        ),
      )
      .forRoutes(...HOOK_API_ROUTES);

    consumer
      .apply(
        throwMiddlewareErrors(express.json({ limit: GLOBAL_BODY_LIMIT })),
        throwMiddlewareErrors(
          express.urlencoded({ extended: true, limit: GLOBAL_BODY_LIMIT }),
        ),
        throwMiddlewareErrors(
          express.text({
            type: 'application/x-ndjson',
            limit: GLOBAL_BODY_LIMIT,
          }),
        ),
      )
      .exclude(...LOG_INGEST_ROUTES, ...HOOK_API_ROUTES)
      .forRoutes('*');
  }
}
