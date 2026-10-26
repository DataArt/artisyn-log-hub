---
paths:
  - "client/**"
---

This is the Vite + React front-end for Artisyn Log Hub.

# UI Component Navigation

**Before changing any UI component**, read [
`docs/knowledgebase/client-component-map.md`](../docs/knowledgebase/client-component-map.md).
It maps every file to its purpose and has a lookup table to find the right file without searching the tree.

**After adding, removing, renaming, or significantly changing a component**, update that file to keep it accurate.

Instead of doing grep etc, first read file docs/knowledgebase/client-component-map.md and plan your changes accordingly.

# Work cycle

Follow the `adlc-lh:check-health` skill (build/lint/test commands come from
`.claude/repo_config/repo-health-checks.json`). If it is not clear whether a failure is a broken
test or an error in the code — ask the user.

# Notes

I do not have python, do not try to use or install.
If you need some auxiliary scripts - use nodeJS.
Use only TypeScript.

This package is isolated from the monorepo `server/` package. The one sanctioned shared code is the
repo-local `@loghub/pricing` package (`packages/pricing/`, aliased in `vite.config.ts` /
`tsconfig.json`): pricing math and tier validation live there, never as a client copy.

# Models

See `client/README.md` § Models.

`src/models/` holds **only** types for responses from `src/viewer/api.ts` (`/api/projects`, `/api/sessions`,
`/api/sessions/:id/trace`, `/api/analytics/usage`). The backend is expected to conform to these types later.

Do not add types copied from `server/` or from unrelated API specs. UI helpers (tool registry, etc.) live under
`src/viewer/lib/`, not `models/`.

# Path display

client UI is shown for different users with different laptops. Never show local info like
local file path e.g. C:\work\project\CLAUDE.md
show all paths relative to the root of the repo.

# spacing

Users may have wide screens.
make UI in way that there will be no components full width with one element on the right and one on the left and 1000px+
space between them.

But if panel has enough content for full width, e.g. top bar - use full width.


# component size

If a component file exceeds 10 KB, consider splitting it into smaller components; above 20 KB the
`post-impl-check-client-component-size` check will force a split. You may skip the 10 KB
threshold if splitting would lead to non-intuitive code. Extracted components should have clear
purpose.

# Navigation

Never use `window.location.hash =` or `history.*` directly. Use react-router-dom's own hooks, paired with the
path builders in `src/viewer/hooks/useHashRoute.ts`. That file exports only the `routes` object — it has no
navigation functions of its own.

Two APIs — pick the right one:

| API | When to use |
|---|---|
| `useNavigate()` + `routes.xxx()` | User leaves the current page: nav clicks, form submits, auth redirects, post-mutation redirects. Pushes a history entry so back/forward works. |
| `useSearchParams()` | In-page URL sync: syncing filters, selected item, or tab state to the URL so the page is shareable/refreshable. Copy the current params, mutate the copy, then call `setSearchParams(next, { replace: true })` — this does **not** create a history entry. |

Always build page paths with `routes.*` helpers from `useHashRoute.ts`. Never hand-craft hash strings.

```tsx
// page navigation
import { useNavigate } from 'react-router-dom';
import { routes } from '../hooks/useHashRoute';
const navigate = useNavigate();
navigate(routes.team(teamId));

// in-page URL sync (e.g. tab state, filters, selected item)
import { useSearchParams } from 'react-router-dom';
const [searchParams, setSearchParams] = useSearchParams();
function setTab(next: Tab) {
  const nextParams = new URLSearchParams(searchParams);
  nextParams.set('tab', next);
  setSearchParams(nextParams, { replace: true });
}
```

**Rule: tab selection must always live in the URL.** Any page-level or panel-level tab state (`PageTabs`
`value`/`onValueChange`) must be backed by `useSearchParams()`, not local `useState`, so the active tab is
bookmarkable and survives a refresh. See `useRepositoryViewState.ts` and `useAdminTabState.ts` for the pattern.
`TeamDetailPage.tsx` still uses local `useState` for its tabs — this is a known exception, not a pattern to copy.

# Base URL for links (emails, generated URLs)

Never build an absolute URL (password-reset links, invite links, anything emailed or shown to a
user) from a hardcoded string or an ad-hoc env var like `APP_BASE_URL`, and never on the client.
There are exactly two sources, chosen by who receives the link:

- **Emailed links** (signup confirmation, resend, forgot-password, the admin pending-registration
  resend) come only from the server's `PUBLIC_BASE_URL`, via `getEmailLinkBaseUrl()` /
  `getPublicBaseUrl()` in `server/src/common/public-base-url.ts`. Never derive them from the
  request: the `Host` header is attacker-controlled, so a request-derived emailed link lets anyone
  send a victim a reset link pointing at their own host (account takeover). Outside production the
  fallback is `http://localhost:5173`; in production with `PUBLIC_BASE_URL` unset the email is
  skipped and `mail: PUBLIC_BASE_URL not set — email link not sent` is logged once.
- **Links returned in a response body to an authenticated admin** (the admin reset link, the
  release download link) keep using the incoming request (protocol + `Host` — see
  `server/src/common/request-base-url.ts`'s `getRequestBaseUrl()`), threaded from the controller
  (`@Req()`) down to wherever the link is built. The client is served from the same origin as the
  API (`ServeStaticModule` in `server/src/app.module.ts`), so this matches what the admin sees.
