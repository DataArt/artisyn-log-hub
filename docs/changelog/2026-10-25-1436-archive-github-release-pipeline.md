# Release install guide and VirusTotal verdicts fixed

- The release VirusTotal scan waits for a finished analysis instead of reporting `0/0 engines` as clean for installer scripts VirusTotal had not analysed yet.
- The install guide explains the expected Sigma "web request" match on `install.ps1` and describes a script-free install from the verified zip.
- The install guide's data-location check no longer flags the empty volume that the postgres 18 image always adds.
