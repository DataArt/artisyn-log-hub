# First launch

On its first launch AgentBook downloads what it needs, once. The screen lists exactly what, with
the version, the size and the progress:

| What | Why |
|---|---|
| **Node.js runtime** | runs the devcontainer tool |
| **Dev Container CLI** (`@devcontainers/cli`) | builds a project's own Equipment (`.devcontainer`) |
| **Standard Equipment** | Ubuntu LTS with git, curl and Node.js, for folders without a `.devcontainer` |

- Every file is checked against a checksum built into AgentBook before it is used. A file that
  does not match, or a download that was cut, is thrown away; nothing half-downloaded is kept.
- The downloads use your computer's proxy settings.
- The Standard Equipment is built by your Docker engine. Its system packages come from Ubuntu's
  servers and are checked by Ubuntu's own signatures.

Next time, AgentBook starts right away.

## When a download fails

The screen says what failed in plain words, for example that there is no internet connection.
Check the connection and press **Retry**. Only what is missing is downloaded again.

If only the devcontainer tool is missing, folders without a `.devcontainer` still work.

Besides this first download, AgentBook itself needs no internet. Claude Desktop and the agent do.
