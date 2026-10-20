// Must stay the first import: it snapshots process.env before AppModule's module-level dotenv
// calls run, so the run's pinned env (AUTH_MODE, E2E_DB_SCHEMA, ...) can be restored below.
import { envBeforeAppModule, restoreEnv } from '../helpers/env-snapshot.helper';
import 'reflect-metadata';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
} from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { createTestApp } from '../helpers/create-app.helper';
import { allCases, registryRoutes } from './registry';

restoreEnv(envBeforeAppModule);

/**
 * Meta-test of the contract registry (docs/qaa-overview/scenarios/05 §3).
 *
 * Boots a private copy of the app in this worker and lists its routes from two independent
 * sources: Nest metadata (DiscoveryService + MetadataScanner: controller prefix + handler path +
 * RequestMethod) and the Express 5 router stack. Then:
 *   - both sources agree (a route registered past the controllers is caught);
 *   - router ⊆ registry: a new endpoint cannot land without a contract row;
 *   - registry ⊆ router: a renamed/removed endpoint leaves no dead row behind;
 *   - every row is well-formed (unique id, an oracle or an explicit exclusion with a reason).
 * The expected number of routes is never hard-coded — the sets are compared.
 */

const HINT =
  'add a row to test/contract/registry/* (see test/contract/README.md, "Adding a family or a registry row")';

/**
 * Express routes that do not come from a controller and carry no DB contract (05 §6): the
 * ServeStaticModule SPA fallback. Matched by path pattern, because its exact spelling belongs to
 * @nestjs/serve-static.
 */
const NON_CONTROLLER_ROUTES: readonly RegExp[] = [/^GET \/\{?\*/, /^GET \/\*/];

function joinPath(prefix: string, path: string): string {
  const parts = [prefix, path]
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return `/${parts.join('/')}`;
}

function asList(value: unknown): string[] {
  if (value === undefined || value === null) return [''];
  const one = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  return Array.isArray(value) ? value.map(one) : [one(value)];
}

interface DiscoveredRoutes {
  routes: Set<string>;
  unsupported: string[];
}

function routesFromMetadata(app: INestApplication): DiscoveredRoutes {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const routes = new Set<string>();
  const unsupported: string[] = [];
  for (const wrapper of discovery.getControllers()) {
    const metatype = wrapper.metatype as
      | (abstract new (...args: never[]) => unknown)
      | null;
    if (!metatype || !wrapper.instance) continue;
    const prefixes = asList(Reflect.getMetadata(PATH_METADATA, metatype));
    const prototype = Object.getPrototypeOf(wrapper.instance) as object;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const paths: unknown = Reflect.getMetadata(PATH_METADATA, handler);
      if (paths === undefined) continue;
      const method = Reflect.getMetadata(
        METHOD_METADATA,
        handler,
      ) as RequestMethod;
      const verb = RequestMethod[method];
      for (const prefix of prefixes) {
        for (const path of asList(paths)) {
          const key = `${verb} ${joinPath(prefix, path)}`;
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) {
            unsupported.push(`${key} (${metatype.name}.${name})`);
          } else {
            routes.add(key);
          }
        }
      }
    }
  }
  return { routes, unsupported };
}

interface ExpressLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
}

function routesFromExpress(app: INestApplication): Set<string> {
  const instance = app.getHttpAdapter().getInstance() as {
    router?: { stack: ExpressLayer[] };
    _router?: { stack: ExpressLayer[] };
  };
  const stack = (instance.router ?? instance._router)?.stack ?? [];
  const routes = new Set<string>();
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const path of asList(layer.route.path)) {
      for (const [method, on] of Object.entries(layer.route.methods)) {
        if (!on || method === '_all') continue;
        const key = `${method.toUpperCase()} ${path}`;
        if (NON_CONTROLLER_ROUTES.some((re) => re.test(key))) continue;
        routes.add(key);
      }
    }
  }
  return routes;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe('contract registry vs the live router', () => {
  let app: INestApplication;
  let fromMetadata: DiscoveredRoutes;
  let fromExpress: Set<string>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();
    app = await createTestApp(moduleFixture);
    fromMetadata = routesFromMetadata(app);
    fromExpress = routesFromExpress(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('finds the controller routes at all', () => {
    expect(fromMetadata.routes.size).toBeGreaterThan(0);
  });

  it('has no @All / @Sse / other-verb routes (they need an explicit decision first)', () => {
    expect(fromMetadata.unsupported).toEqual([]);
  });

  it('Nest metadata and the Express router list the same routes', () => {
    const onlyRouter = sorted(
      [...fromExpress].filter((r) => !fromMetadata.routes.has(r)),
    );
    const onlyMetadata = sorted(
      [...fromMetadata.routes].filter((r) => !fromExpress.has(r)),
    );
    expect({ onlyRouter, onlyMetadata }).toEqual({
      onlyRouter: [],
      onlyMetadata: [],
    });
  });

  it(`every router route has a registry row — ${HINT}`, () => {
    const registered = registryRoutes() as Set<string>;
    const missing = sorted(
      [...fromMetadata.routes].filter((r) => !registered.has(r)),
    );
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} route(s) have no contract row — ${HINT}:\n${missing.map((r) => `  ${r}`).join('\n')}`,
      );
    }
  });

  it('every registry row points at a live route', () => {
    const dead = sorted(
      [...registryRoutes()].filter((r) => !fromMetadata.routes.has(r)),
    );
    if (dead.length > 0) {
      throw new Error(
        `${dead.length} registry row route(s) match no live route (renamed or removed endpoint? update the registry):\n` +
          dead.map((r) => `  ${r}`).join('\n'),
      );
    }
  });

  it('every registry row is well-formed', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const c of allCases()) {
      if (seen.has(c.id)) problems.push(`${c.id}: duplicate id`);
      seen.add(c.id);
      if (c.kind === 'excluded') {
        if (!c.reason.trim())
          problems.push(`${c.id}: an excluded row needs a reason`);
        continue;
      }
      const oracles = [c.read, c.write, c.noDb].filter(
        (x) => x !== undefined,
      ).length;
      if (oracles > 1)
        problems.push(`${c.id}: more than one of read / write / noDb`);
      if (oracles === 0 && !c.sameExpectedAs && c.expect.status < 400) {
        problems.push(
          `${c.id}: a 2xx/3xx row needs read, write, noDb or sameExpectedAs`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
