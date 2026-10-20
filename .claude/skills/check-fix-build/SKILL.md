---
name: check-fix-build
description: "Run command once I ask to check dist build"
---

Build command comes from `.claude/repo_config/repo-health-checks.json` (the `build` check). Test
credentials are in `CLAUDE.local.md`.

In root project folder:

1. Run the build check from `repo-health-checks.json` — ensure it builds without errors.
2. Check the list of assets in `dist/` — ensure there are no files unrelated to dist
   (like: docs/, test/, perftests/, etc).
3. Write `dist/.env`:

```text
PORT=3001
COOKIE_SECURE=false
DATABASE_URL=postgresql://postgres:pw@localhost:5432/a-log
```

4. Run the server by `node index.js` in the dist folder.
5. Open `http://localhost:3001/`, ensure the SPA loads, create a test user with `<random>@domain.name`.
6. Check that the user can log in.
7. Ensure a log file in `dist/logs` is created; check server logs for no errors.
8. Log in with the test credentials from `CLAUDE.local.md` — ensure you see the repositories list,
   click one, ensure the sessions list loads.

Apply fixes if necessary.
