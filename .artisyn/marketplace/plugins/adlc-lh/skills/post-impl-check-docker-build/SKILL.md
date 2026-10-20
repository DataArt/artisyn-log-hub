---
name: post-impl-check-docker-build
description: "Post-implementation check: verify the Docker image builds successfully."
---

Verify the Docker image builds without errors. Building is the whole check — do NOT run the
container.

## How to run

1. From the repo root (where the `Dockerfile` is), build with a throwaway tag:

   ```
   docker build -t post-impl-check-verify .
   ```

2. The build is long-running (several minutes — client build, server build via ncc, migrations/
   prebuilds copy, image export). Launch it in the background and **wait for its completion
   notification before doing anything else**. Never report a result while the build is still
   running, and never substitute a placeholder/interim result for the real outcome — if you
   cannot wait for or observe the build's completion, report the check as a hard blocker instead.

3. Success = the build ran end-to-end with exit code 0 and the image was tagged. Confirm from the
   actual build output, not by assumption.

4. If the build fails, fix the cause and build again until it succeeds.

5. Clean up afterward: `docker rmi post-impl-check-verify` (the verification image is temporary;
   do not leave it behind).
