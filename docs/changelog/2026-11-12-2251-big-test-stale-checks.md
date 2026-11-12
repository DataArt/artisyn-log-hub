# Big pre-prod E2E test: stale checks fixed

The manual `/big-prod-e2e-test` again matches the current UI. It reads the Anatomy tab, the Bash detail-pane status badge and the rejected-call modal. Its Node LTS algorithm check now copies the algorithm example rows into the container. The git-root check, which other processes writing to the repo made unreliable, is gone.
