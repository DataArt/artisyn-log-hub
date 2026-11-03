---
reviewed: no
reviewer: none
---

# User-docs link resolution

## Purpose

The user documentation is one page set (`user-docs/` plus two hook files, listed in
`user-docs/nav.json`) shown in two places: the in-app help and the GitHub Pages site. Links between
pages are written as real relative file paths so they also work when the files are read on GitHub.
This algorithm decides what each link points at (another page, an anchor, the web, or nothing),
so the help generator and the site renderer can fail on a broken link and rewrite page links to
the target's own name (`<slug>.md` in the app, `<slug>.html` on the site).

## Code

- Implementation: `scripts/user-docs/links.js` (`resolveLink`, `rewritePageLinks`; `loadNav` reads
  `nav.json`, `findLinks` lists the hrefs). Callers: `scripts/user-docs/generate-help.js`,
  `scripts/site/build-site.mjs`, the help scenarios (through `tests/scenarios/helpers/help-nav.ts`).
- Twins: `client/src/viewer/help/help-links.ts` (`parseHelpHref`) applies the same rules to the
  already-rewritten app copies, so it only ever sees `<slug>.md[#anchor]`, `#anchor` and external
  links; it is not driven by this doc.
- Test: `scripts/__tests__/user-docs-links.algo.test.js` (`npm run test:scripts`).

## Input and output

- `nav` is `{ pages: [{ slug, file }] }` (what `loadNav` returns, reduced to the two fields the
  algorithm reads). `file` is the absolute path of the page's source: `user-docs/<slug>.md`, or
  `user-docs/` + the nav entry's `source` resolved (`../hook/INSTALL_HOOK.md` →
  `<repo>/hook/INSTALL_HOOK.md`).
- `fromFile` is the absolute path of the page the link is written in.
- Paths are compared with `/` separators (Windows `\` is converted first), so the examples use
  POSIX paths under a made-up root `/repo`.

## Rules

**`resolveLink(href, fromFile, nav)`**, `href` trimmed; the first matching rule wins:

1. `href` starts with `http:`, `https:` or `mailto:` (any case): `{ kind: 'external' }`.
2. `href` starts with `#`: `{ kind: 'anchor', anchor: <href without the #> }`.
3. Empty, any other scheme (`ftp:`, `data:` …), or a root-absolute path (`/…`): `{ kind: 'unresolved' }`.
4. Split at the first `#` into the path part and `anchor` (`null` when there is no `#`). An empty
   path part or one containing `?`: `unresolved`.
5. URI-decode the path part (`%20` → space), join it to `dirname(fromFile)` and normalise
   (`./` and `../` collapse). When the result equals some page's `file` — exact, case-sensitive —
   the result is `{ kind: 'page', slug, anchor }`.
6. No page matched, there is no `#`, and the normalised path ends in
   `/user-docs/images/<name>.svg` or `.png` (`<name>` lowercase letters, digits and `-`, no
   subfolder): `{ kind: 'asset', path: 'images/<name>.<ext>' }` — an image shipped with the docs.
   The generators check that the file exists and copy it next to the pages (`images/` in the app's
   help folder and in the site's `docs/`), so the same relative path works on GitHub, in the app
   and on the site, offline too.
7. Otherwise `unresolved` (a missing page, a file outside the page set such as
   `../server/README.md`, an image outside `user-docs/images/` or of another type).

**`rewritePageLinks(markdown, fromFile, nav)`**: find every link href — inline `[x](href)` /
`![x](href)` (also `<href>` and a title) and reference definitions `[label]: href` — skipping
fenced code blocks and inline code spans. For each href whose `resolveLink` kind is `page`, the
wanted text is `<slug>.md` or `<slug>.md#<anchor>`; when the href differs from it, it is replaced.
Every other byte of the markdown stays as it was (external, anchor and unresolved links included).

## Edge cases

- External links, both schemes and `mailto:`: UDL-01, UDL-02. Anchor-only link: UDL-03.
- Page link without and with an anchor: UDL-04, UDL-05; `./` prefix: UDL-11.
- Source-backed pages: from `user-docs/` up into `hook/`: UDL-06; between the two hook files: UDL-07.
- Unresolved: a missing page UDL-08, a repo file outside the page set UDL-09, wrong case UDL-12,
  root-absolute UDL-13, a query string UDL-14; an image of another type UDL-20, outside
  `user-docs/images/` UDL-21, with an anchor UDL-22.
- Asset: an image in `user-docs/images/` UDL-10, reached from a hook page through `../user-docs/`
  UDL-23.
- Rewrite of inline links with and without an anchor, leaving an already-correct link alone: UDL-15.
- Links inside inline code and a fenced block are untouched: UDL-16.
- Reference definition rewritten: UDL-17. External, anchor and unresolved links untouched: UDL-18.
- `./slug.md` rewritten to the plain name: UDL-19.

## Examples

`input.fn` is the exported function to call and `input.args` its argument list —
`[href, fromFile, nav]` for `resolveLink`, `[markdown, fromFile, nav]` for `rewritePageLinks`;
`expected.result` is its exact return value. The page `/repo/user-docs/getting-started.md` is the
usual `fromFile`.

Rows (23): [`docs/algorithm-examples/user-docs-links.json`](../../algorithm-examples/user-docs-links.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Comparing paths case-insensitively -> UDL-12.
- Joining the href to the repo's `user-docs/` instead of `dirname(fromFile)` -> UDL-07.
- Not normalising `../` and `./` -> UDL-06, UDL-11, UDL-19.
- Keeping the query string in the path part -> UDL-14; treating a root-absolute path as relative
  to the repo -> UDL-13.
- Rewriting links inside code -> UDL-16; skipping reference definitions -> UDL-17.
- Dropping the anchor on rewrite -> UDL-15.

## Where the result is visible

`npm run build:help` / `node scripts/user-docs/generate-help.js --check` and `npm run build:site`
print `<file>: <href>` and exit 1 on an unresolved link (also the "user docs and site" step of
`checks.yml`). In the app, a help link to another page switches the article (Help menu); on the
site it opens `docs/<slug>.html`.
