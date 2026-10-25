# Release notes lead with the changelog; install kit fixes

- Release notes now open with "What's new", built from the `docs/changelog/` entries of the release; the raw commit list is folded below it.
- The release VirusTotal scan waits for a finished analysis instead of reporting `0/0 engines` as clean for installer scripts VirusTotal had not analysed yet.
- The install guide explains the expected Sigma "web request" match on `install.ps1` and describes a script-free install from the verified zip.
- Install kit texts are clearer: links instead of repository paths, the `AUTH_MODE` default explained, a checksum command that works on a partial download, and no false alarm about the empty volume the postgres 18 image adds.
