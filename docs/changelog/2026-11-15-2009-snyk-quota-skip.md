# Snyk scans are skipped when the free test limit runs out

When Snyk's monthly free-plan test limit is used up, the CI security scans now report the Snyk rows
as skipped instead of a tool error, so the security badge and the PR summary stay clean.
