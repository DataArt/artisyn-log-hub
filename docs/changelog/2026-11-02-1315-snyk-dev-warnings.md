# Node.js 26 LTS and accurate Snyk "fixable" count

- The container image, the dev sandbox and CI now run Node.js 26 LTS (26.13.0, was 24.22.1).
- The security scan report no longer marks an issue as fixable when an upgrade would remove only some of its dependency paths.
