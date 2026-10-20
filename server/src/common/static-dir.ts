import * as fs from 'fs';
import { join, sep } from 'path';

/**
 * Resolves the runtime `public/static` directory across all deployment layouts:
 *
 *  - ncc production bundle: every module is flattened into `dist/index.js`, so
 *    `__dirname` is `dist/` and the static assets Docker copies in live at
 *    `dist/public/static`.
 *  - dev / unbundled, running TS source directly (ts-node, jest): `__dirname` is
 *    the module's own source dir (e.g. `server/src/installer`), and the static
 *    dir sits at `server/src/public/static` — one level up from the module dir.
 *  - dev / unbundled, running the plain-tsc `dist/` build (`nest start --watch`,
 *    per `nest-cli.json` having no webpack config, mirrors `src/`'s directory
 *    structure): `__dirname` is `dist/installer`, so the naive "one level up"
 *    fallback lands in `dist/public/static` — but nothing ever copies the
 *    prebuilt installer tarball there (only the ncc/Docker build's explicit
 *    `COPY` does that for the *bundled* case above); `scripts/build-hooks-installer.js`
 *    always writes it to the TS source tree. That directory can still *exist*
 *    (e.g. `AppModule.onApplicationBootstrap()` writes `installer-version.json`
 *    into it at runtime), so its mere existence is a false signal — this is
 *    what made the installer download 404 again after a clean `nest start --watch`
 *    restart, even though the ncc-bundle fix above still worked correctly.
 *
 * A fixed `../public/static` is correct for the second case but overshoots to
 * `/app/public/static` in the bundle or lands in an asset-less `dist/public/static`
 * in the third case (this fix). We probe the bundle-relative candidate first, then the
 * TS-source candidate (only reachable when `moduleDir` is actually under a `dist/` tree),
 * and fall back to the naive dev-relative candidate. The `exists` param is injectable for
 * unit tests.
 */
/**
 * True only for the ncc production bundle, where every module is flattened into `dist/index.js`
 * so a `public/static` dir sits right next to `moduleDir` itself. False for both dev (ts-node/
 * plain-tsc `dist/`) and jest (server/src) — i.e. false in every context that isn't the actual
 * deployed artifact.
 */
export function isBundledRuntime(
  moduleDir: string,
  exists: (p: string) => boolean = fs.existsSync,
): boolean {
  return exists(join(moduleDir, 'public', 'static'));
}

export function resolveStaticDir(
  moduleDir: string,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  const bundled = join(moduleDir, 'public', 'static');
  if (exists(bundled)) return bundled;

  if (moduleDir.includes(`${sep}dist${sep}`)) {
    const srcDir = join(
      moduleDir.replace(`${sep}dist${sep}`, `${sep}src${sep}`),
      '..',
      'public',
      'static',
    );
    if (exists(join(srcDir, 'artisyn-hooks-installer.tgz'))) return srcDir;
  }

  return join(moduleDir, '..', 'public', 'static');
}

/**
 * Resolves the directory holding the downloadable release zips.
 *
 * The zips are a **sibling** of the served `public/` tree, never inside it:
 * `ServeStaticModule` would otherwise hand multi-hundred-MB bundles to any
 * anonymous visitor who guessed the file name, and the whole point of the
 * signed download link is that those files are not publicly reachable. They
 * are also never baked into the image — a bind mount drops them in.
 *
 *  - ncc production bundle (`moduleDir` is `dist/`, detected the same way as
 *    `resolveStaticDir` via `isBundledRuntime`): `dist/releases`, i.e.
 *    `/app/dist/releases`, which is exactly the container-side mount point
 *    both compose files use.
 *  - dev / jest (`moduleDir` is `server/src/releases`) and the plain-tsc build
 *    (`server/dist/releases`): two levels up, landing on `server/releases` in
 *    both cases. Two levels, not one: one level up is the `releases` *code*
 *    directory itself, which must never hold zips. `resolveStaticDir`'s middle
 *    `src/` candidate is deliberately not reproduced — nothing ever writes
 *    zips into the TypeScript source tree.
 *
 * `RELEASES_DIR` (absolute) overrides this entirely; that is what tests set.
 * The `exists` param is injectable for unit tests.
 */
export function resolveReleasesDir(
  moduleDir: string,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  if (isBundledRuntime(moduleDir, exists)) return join(moduleDir, 'releases');
  return join(moduleDir, '..', '..', 'releases');
}
