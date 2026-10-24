# Gitleaks scans the release branch

The CI secret scan now also runs on pushes to `release`; `main` and `release` are protected by a ruleset that requires a PR and a passing scan.
