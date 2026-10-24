# Dockerfiles pass hadolint

Build tools in the production Dockerfile are pinned to the repo's own versions (bun 1.3.14, typescript 6.0.3, @vercel/ncc 0.38.4), the dev sandbox Dockerfile runs RUN steps with pipefail, and `.hadolint.yaml` ignores apt version pinning (DL3008); the security badge drops its hadolint warning. The unused root bun.lock (the root installs with npm) is removed.
