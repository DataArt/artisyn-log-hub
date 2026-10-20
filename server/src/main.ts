import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { getTrustedGateway } from './auth/utils/container-gateway.util';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { warnKnownSecrets } from './common/known-secrets';
import { AppLogger } from './common/app-logger';
import { createPrecompressedStaticMiddleware } from './common/precompressed-static';
import { parseTrustProxy } from './common/trust-proxy';
import { listenForApiKeyInvalidation } from './cluster/api-key-cache-ipc';
import { runClusterPrimary } from './cluster/cluster-primary';
import { CLUSTER_MODE_PRIMARY } from './cluster/cluster.constants';
import { initializeDatabase } from './database/database-init';
import cluster from 'node:cluster';
import { join } from 'path';

/**
 * Last-resort error reporting for failures the framework never sees (a
 * rejected bootstrap promise, an uncaught exception, an unhandled rejection
 * anywhere in the process). Console output comes first and unconditionally,
 * since the AppLogger/file write below is not guaranteed to succeed (e.g. if
 * the crash happened before logging was initialized, or the filesystem is
 * the reason for the crash in the first place).
 */
function logFatalError(source: string, err: unknown): void {
  console.error(`[${source}]`, err);
  try {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    new AppLogger().error(message, stack, source);
  } catch (loggingError) {
    console.error(
      `[${source}] failed to write error to log file:`,
      loggingError,
    );
  }
}

process.on('uncaughtException', (err) => {
  logFatalError('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logFatalError('unhandledRejection', reason);
  process.exit(1);
});

async function bootstrap() {
  const appLogger = new AppLogger();

  // Everything the database needs, done and finished before the DI container
  // exists — no provider, scheduler or background timer can observe a
  // half-migrated schema. See src/database/database-init.ts.
  await initializeDatabase({ logger: appLogger });

  // SESSION_SECRET is resolved by now; flag publicly known secrets / DB
  // passwords (warning only, silent in Mode 1). Once per worker process.
  warnKnownSecrets(process.env.AUTH_MODE, appLogger);

  // Apply API-key cache invalidations rebroadcast by the cluster primary
  // (no-op without an IPC channel, i.e. outside cluster mode).
  listenForApiKeyInvalidation();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: appLogger,
  });

  // Behind a reverse proxy (TRUST_PROXY set) Express must be told to honour the
  // X-Forwarded-* headers, so req.protocol/req.ip reflect the original client
  // request rather than the proxy hop. Left untouched when disabled (default),
  // keeping existing installs bit-for-bit identical.
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== false) {
    app.set('trust proxy', trustProxy);
    appLogger.log(`trust proxy enabled: ${String(trustProxy)}`, 'Bootstrap');
  }

  // Mode 1's localhost gate additionally accepts the container's own default
  // gateway, which is the address host→published-port traffic arrives
  // from. Resolve it here so the widening is visible in `docker compose logs
  // app` rather than invisible — and so the memo is warm before any request.
  if (process.env.AUTH_MODE === 'none') {
    const trustedGateway = getTrustedGateway();
    if (trustedGateway) {
      appLogger.log(
        `AUTH_MODE=none: container detected, also trusting default gateway ${trustedGateway} as a local caller`,
        'Bootstrap',
      );
    }
  }

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  app.use(
    (
      _req: unknown,
      res: { setHeader: (k: string, v: string) => void },
      next: () => void,
    ) => {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      next();
    },
  );

  // Serve the build-time `.br`/`.gz` siblings when the client accepts them.
  // Registering here is early enough to beat ServeStaticModule's
  // `express.static`: that one is registered from `onModuleInit`, which Nest
  // calls from `NestApplication.init()` — i.e. inside `app.listen()` below,
  // after everything `app.use()`d in bootstrap. The middleware above already
  // relies on the same ordering.
  //
  // `join(__dirname, 'public')` is the same expression app.module.ts uses for
  // `rootPath`: `server/src/public` in dev (no client assets there, so the
  // manifest is empty and the middleware is a no-op) and `dist/public` in the
  // ncc bundle.
  app.use(createPrecompressedStaticMiddleware(join(__dirname, 'public')));

  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);

  // Prevent intermittent "Connecting" delays caused by the server closing an
  // idle keep-alive socket while the browser is about to reuse it.
  // headersTimeout must always exceed keepAliveTimeout.
  const httpServer = app.getHttpServer();
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;

  // Nest's own "Nest application successfully started" log (emitted inside
  // app.listen() above, via this same appLogger) never states which port was
  // actually bound — surface that explicitly so it's visible without having
  // to separately netstat/Get-NetTCPConnection the process.
  const address = httpServer.address();
  const port = typeof address === 'string' ? address : address?.port;
  appLogger.log(`Server started on port ${port}`, 'Bootstrap');
}

// Primary/worker mode switch. `cluster.fork()` inherits CLUSTER_MODE=primary
// into every worker, so `!cluster.isWorker` — not the env var — is what
// distinguishes the supervisor from its children. The module-level
// uncaughtException / unhandledRejection handlers above serve both branches;
// the primary adds none of its own.
if (process.env.CLUSTER_MODE === CLUSTER_MODE_PRIMARY && !cluster.isWorker) {
  runClusterPrimary(new AppLogger());
} else {
  bootstrap().catch((err: unknown) => {
    logFatalError('bootstrap', err);
    process.exit(1);
  });
}
