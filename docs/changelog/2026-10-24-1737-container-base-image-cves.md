# Production image on Node 24 Alpine; security badge opens a report

The production image now runs on `node:24.22.1-alpine` without npm (Snyk Container: the Debian base's wont-fix critical/high CVEs are gone), and the README security badge links to `REPORT.md` on `ci-reports` with every scan's critical/high Snyk issues and the nightly VirusTotal verdicts.
