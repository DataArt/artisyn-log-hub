# Secret scanning on commit and push

Git hooks now run a gitleaks secret scan on every commit and push (with a repo allowlist), the Claude sandbox image ships gitleaks, and an off-by-default CI scan workflow is added.
