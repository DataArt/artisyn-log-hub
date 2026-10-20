---
name: api-endpoint
description: Add a new ASP.NET Core minimal-API endpoint to src/Api/Program.cs. Use when asked to add an HTTP endpoint or run /api-endpoint <METHOD> <path> <behaviour>.
---

# Add a minimal-API endpoint

The argument describes the endpoint, for example `GET /version returning the assembly version`.

1. Open `src/Api/Program.cs`.
2. Add one `app.Map<Verb>("<path>", ...)` call (`MapGet`, `MapPost`, `MapPut` or `MapDelete`) next to
   the existing `app.MapGet("/health", ...)` line, before `app.Run();`.
3. Return the result through `Results.Ok(...)` (or another `Results.*` helper) with an anonymous
   object, the same shape as `/health`.
4. Keep the handler inline as a lambda; do not add controllers, services or new packages.
5. Keep the trailing `public partial class Program { }` so `WebApplicationFactory<Program>` tests
   keep working.
6. Reply with the endpoint you added. Tests belong in `tests/Api.Tests` and are not part of this skill.
