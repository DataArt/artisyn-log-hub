# GitHub release pipeline

- Pushing to the `release` branch now builds a multi-arch image, publishes it to `ghcr.io/dataart/artisyn-log-hub` and creates a GitHub Release with an install kit (`install.sh` / `install.ps1`, checksums, attestations, VirusTotal results) and a `CHANGES.md` built from the changelog entries added since the previous release.
- PRs get a new required `fast-checks` check (typecheck and algorithm tests).
- The in-app Release Downloads feature and its download links are removed; `/health/version` now returns `{version, gitCommit}`.
- `npm run release` becomes `npm run local-release-bundle` (offline test bundle only).
