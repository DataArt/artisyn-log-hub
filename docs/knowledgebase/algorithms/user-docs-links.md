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

```examples
[
  {"id":"UDL-01","input":{"fn":"resolveLink","args":["https://github.com/DataArt/artisyn-log-hub","/repo/user-docs/getting-started.md",{"pages":[]}]},"expected":{"result":{"kind":"external"}},"note":"Rule 1: starts with https:."},
  {"id":"UDL-02","input":{"fn":"resolveLink","args":["MAILTO:admin@example.com","/repo/user-docs/getting-started.md",{"pages":[]}]},"expected":{"result":{"kind":"external"}},"note":"Rule 1: mailto: in any case."},
  {"id":"UDL-03","input":{"fn":"resolveLink","args":["#what-is-collected","/repo/user-docs/data-collection.md",{"pages":[]}]},"expected":{"result":{"kind":"anchor","anchor":"what-is-collected"}},"note":"Rule 2: anchor = href without the leading #."},
  {"id":"UDL-04","input":{"fn":"resolveLink","args":["session-log.md","/repo/user-docs/getting-started.md",{"pages":[{"slug":"session-log","file":"/repo/user-docs/session-log.md"}]}]},"expected":{"result":{"kind":"page","slug":"session-log","anchor":null}},"note":"Rule 5: /repo/user-docs + session-log.md = /repo/user-docs/session-log.md = the file of session-log; no # so anchor null."},
  {"id":"UDL-05","input":{"fn":"resolveLink","args":["data-collection.md#what-is-collected","/repo/user-docs/trust-model.md",{"pages":[{"slug":"data-collection","file":"/repo/user-docs/data-collection.md"}]}]},"expected":{"result":{"kind":"page","slug":"data-collection","anchor":"what-is-collected"}},"note":"Rule 4 splits off anchor what-is-collected; rule 5 matches /repo/user-docs/data-collection.md."},
  {"id":"UDL-06","input":{"fn":"resolveLink","args":["../hook/INSTALL_HOOK.md","/repo/user-docs/getting-started.md",{"pages":[{"slug":"getting-started","file":"/repo/user-docs/getting-started.md"},{"slug":"install-hook","file":"/repo/hook/INSTALL_HOOK.md"}]}]},"expected":{"result":{"kind":"page","slug":"install-hook","anchor":null}},"note":"Rule 5: /repo/user-docs/../hook/INSTALL_HOOK.md normalises to /repo/hook/INSTALL_HOOK.md, the source of install-hook."},
  {"id":"UDL-07","input":{"fn":"resolveLink","args":["HOW_HOOK_WORKS.md","/repo/hook/INSTALL_HOOK.md",{"pages":[{"slug":"install-hook","file":"/repo/hook/INSTALL_HOOK.md"},{"slug":"how-hook-works","file":"/repo/hook/HOW_HOOK_WORKS.md"}]}]},"expected":{"result":{"kind":"page","slug":"how-hook-works","anchor":null}},"note":"Rule 5 from inside hook/: /repo/hook + HOW_HOOK_WORKS.md = the source of how-hook-works."},
  {"id":"UDL-08","input":{"fn":"resolveLink","args":["no-such-page.md","/repo/user-docs/getting-started.md",{"pages":[{"slug":"session-log","file":"/repo/user-docs/session-log.md"}]}]},"expected":{"result":{"kind":"unresolved"}},"note":"Rule 5: /repo/user-docs/no-such-page.md is no page's file."},
  {"id":"UDL-09","input":{"fn":"resolveLink","args":["../server/README.md","/repo/user-docs/install-server.md",{"pages":[{"slug":"install-server","file":"/repo/user-docs/install-server.md"}]}]},"expected":{"result":{"kind":"unresolved"}},"note":"Rule 5: /repo/server/README.md exists in the repo but is not in the page set."},
  {"id":"UDL-10","input":{"fn":"resolveLink","args":["images/flow.png","/repo/user-docs/getting-started.md",{"pages":[{"slug":"getting-started","file":"/repo/user-docs/getting-started.md"}]}]},"expected":{"result":{"kind":"asset","path":"images/flow.png"}},"note":"Rule 5: no page's file; rule 6: a png directly in /repo/user-docs/images/ is a docs asset."},
  {"id":"UDL-11","input":{"fn":"resolveLink","args":["./session-log.md#filters","/repo/user-docs/getting-started.md",{"pages":[{"slug":"session-log","file":"/repo/user-docs/session-log.md"}]}]},"expected":{"result":{"kind":"page","slug":"session-log","anchor":"filters"}},"note":"Rule 5: ./ collapses on normalising; anchor filters from rule 4."},
  {"id":"UDL-12","input":{"fn":"resolveLink","args":["Session-Log.md","/repo/user-docs/getting-started.md",{"pages":[{"slug":"session-log","file":"/repo/user-docs/session-log.md"}]}]},"expected":{"result":{"kind":"unresolved"}},"note":"Rule 5 compares case-sensitively: Session-Log.md != session-log.md (GitHub and the Pages host are case-sensitive)."},
  {"id":"UDL-13","input":{"fn":"resolveLink","args":["/user-docs/session-log.md","/repo/user-docs/getting-started.md",{"pages":[{"slug":"session-log","file":"/repo/user-docs/session-log.md"}]}]},"expected":{"result":{"kind":"unresolved"}},"note":"Rule 3: root-absolute paths are never page links."},
  {"id":"UDL-14","input":{"fn":"resolveLink","args":["session-log.md?x=1","/repo/user-docs/getting-started.md",{"pages":[{"slug":"session-log","file":"/repo/user-docs/session-log.md"}]}]},"expected":{"result":{"kind":"unresolved"}},"note":"Rule 4: a path part containing ? is unresolved."},
  {"id":"UDL-15","input":{"fn":"rewritePageLinks","args":["See [the hook](../hook/INSTALL_HOOK.md#step-2) and [the log](session-log.md).\n","/repo/user-docs/getting-started.md",{"pages":[{"slug":"session-log","file":"/repo/user-docs/session-log.md"},{"slug":"install-hook","file":"/repo/hook/INSTALL_HOOK.md"}]}]},"expected":{"result":"See [the hook](install-hook.md#step-2) and [the log](session-log.md).\n"},"note":"First href resolves to install-hook with anchor step-2, wanted install-hook.md#step-2 != href, replaced. Second is already session-log.md, kept."},
  {"id":"UDL-16","input":{"fn":"rewritePageLinks","args":["Write `[x](../hook/INSTALL_HOOK.md)` like this:\n\n```md\n[x](../hook/INSTALL_HOOK.md)\n```\n","/repo/user-docs/getting-started.md",{"pages":[{"slug":"install-hook","file":"/repo/hook/INSTALL_HOOK.md"}]}]},"expected":{"result":"Write `[x](../hook/INSTALL_HOOK.md)` like this:\n\n```md\n[x](../hook/INSTALL_HOOK.md)\n```\n"},"note":"Both links sit in code (an inline span, a fenced block): not links, nothing replaced."},
  {"id":"UDL-17","input":{"fn":"rewritePageLinks","args":["Read [how it works][h].\n\n[h]: ../hook/HOW_HOOK_WORKS.md\n","/repo/user-docs/data-collection.md",{"pages":[{"slug":"how-hook-works","file":"/repo/hook/HOW_HOOK_WORKS.md"}]}]},"expected":{"result":"Read [how it works][h].\n\n[h]: how-hook-works.md\n"},"note":"Reference definition href resolves to how-hook-works, no anchor: replaced by how-hook-works.md."},
  {"id":"UDL-18","input":{"fn":"rewritePageLinks","args":["[site](https://example.com/a.md) [up](#top) [srv](../server/README.md)\n","/repo/user-docs/install-server.md",{"pages":[{"slug":"install-server","file":"/repo/user-docs/install-server.md"}]}]},"expected":{"result":"[site](https://example.com/a.md) [up](#top) [srv](../server/README.md)\n"},"note":"Kinds external, anchor and unresolved: none is page, so every byte stays."},
  {"id":"UDL-19","input":{"fn":"rewritePageLinks","args":["[log](./session-log.md)\n","/repo/user-docs/getting-started.md",{"pages":[{"slug":"session-log","file":"/repo/user-docs/session-log.md"}]}]},"expected":{"result":"[log](session-log.md)\n"},"note":"./session-log.md resolves to session-log; wanted session-log.md differs from the href, replaced."},
  {"id":"UDL-20","input":{"fn":"resolveLink","args":["images/flow.gif","/repo/user-docs/getting-started.md",{"pages":[{"slug":"getting-started","file":"/repo/user-docs/getting-started.md"}]}]},"expected":{"result":{"kind":"unresolved"}},"note":"Rule 6 takes only svg and png; a gif falls to rule 7."},
  {"id":"UDL-21","input":{"fn":"resolveLink","args":["../site/assets/logo.svg","/repo/user-docs/getting-started.md",{"pages":[{"slug":"getting-started","file":"/repo/user-docs/getting-started.md"}]}]},"expected":{"result":{"kind":"unresolved"}},"note":"Rule 6: /repo/site/assets/logo.svg is not in user-docs/images/."},
  {"id":"UDL-22","input":{"fn":"resolveLink","args":["images/flow.svg#part","/repo/user-docs/getting-started.md",{"pages":[{"slug":"getting-started","file":"/repo/user-docs/getting-started.md"}]}]},"expected":{"result":{"kind":"unresolved"}},"note":"Rule 6 needs no #; an anchor into an image is unresolved."},
  {"id":"UDL-23","input":{"fn":"resolveLink","args":["../user-docs/images/otel-team-tab.svg","/repo/hook/INSTALL_HOOK.md",{"pages":[{"slug":"install-hook","file":"/repo/hook/INSTALL_HOOK.md"}]}]},"expected":{"result":{"kind":"asset","path":"images/otel-team-tab.svg"}},"note":"Rule 6 from a hook page: /repo/hook/../user-docs/images/otel-team-tab.svg normalises into user-docs/images/."}
]
```

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
