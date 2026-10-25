# Artisyn Log Hub — Responsibility Matrix (RACI)

This matrix assigns responsibility for operating Artisyn Log Hub between the project maintainers and the
operator organisation. Artisyn Log Hub is a self-hosted open-source project: the project maintainers
supply the software and documentation, and the operator runs it on its own infrastructure.

## Legend

| Code | Meaning |
|---|---|
| **R** | Responsible — performs the activity |
| **A** | Accountable — owns the outcome and approves; exactly one per activity |
| **C** | Consulted — provides input before or during the activity |
| **I** | Informed — kept up to date on the outcome |

## Roles

| Role | Description |
|---|---|
| **Project maintainers** | Artisyn Log Hub development team: builds, secures and documents the product, publishes releases. |
| **Operator IT / Infrastructure** | Operates the host, Docker, network, TLS proxy, backups and monitoring. |
| **Operator Security** | Defines security and data-protection requirements, approves the deployment, handles incidents. |
| **Log Hub Administrator** | Holds the `admin` role in the application: users, pricing, retention, system settings. |
| **Team Owner** | Owns a team in the application: access mode, members and role grants. |
| **End User (Developer)** | Installs the hook in their projects, manages their own API keys and sessions. |

## 1. Product and release

| Activity | Maintainers | Op. IT | Op. Security | LH Admin | Team Owner | End User |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Product development and defect fixing | **A/R** | I | I | C | – | C |
| Security of the product code, dependency updates | **A/R** | I | I | – | – | – |
| Publishing releases (GHCR image, GitHub Release install kit) | **A/R** | I | – | I | – | – |
| Release notes ("What's New") | **A/R** | I | I | I | I | I |
| Product documentation (this help, installation instructions) | **A/R** | C | C | I | I | I |
| Third-party component and license inventory | **A/R** | I | C | – | – | – |
| Hook and installer packages (served by the operator's server) | **A/R** | I | I | I | – | I |

## 2. Deployment and infrastructure

| Activity | Maintainers | Op. IT | Op. Security | LH Admin | Team Owner | End User |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Provisioning the host / VM and Docker Engine | – | **A/R** | C | I | – | – |
| Initial installation from the GitHub Release (`install.sh` / `install.ps1`) | C | **A/R** | I | I | – | – |
| Choosing and configuring `AUTH_MODE` | C | R | **A** | C | – | – |
| Azure Entra ID app registration (Mode 4) | C | R | **A** | I | – | – |
| SMTP relay configuration (Modes 2/3) | – | **A/R** | C | I | – | – |
| TLS certificates and reverse proxy, `TRUST_PROXY` | C | **A/R** | C | – | – | – |
| Network exposure, port binding, firewall rules | – | **A/R** | C | – | – | – |
| Secret management (`.env`: session secret, DB password, Azure secret) | – | **A/R** | C | – | – | – |
| Host OS, Docker and PostgreSQL image patching | – | **A/R** | I | – | – | – |
| Applying product upgrades | C | **A/R** | I | I | – | – |

## 3. Operations

| Activity | Maintainers | Op. IT | Op. Security | LH Admin | Team Owner | End User |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Database and `.env` backups, restore tests | – | **A/R** | I | I | – | – |
| Availability and resource monitoring (`/health`, host metrics) | – | **A/R** | – | I | – | – |
| Monitoring the upload queue and error logs in the admin panel | C | C | – | **A/R** | – | – |
| Server log file retention on the host | – | **A/R** | C | – | – | – |
| Capacity planning (disk for DB, queue and logs) | C | **A/R** | – | C | – | – |
| Model pricing maintenance | C | – | – | **A/R** | – | I |
| Diagnosing application defects | R | C | – | **A** | – | C |

## 4. Identity and access management

| Activity | Maintainers | Op. IT | Op. Security | LH Admin | Team Owner | End User |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Access policy (who may use the system) | – | C | **A** | R | – | I |
| Granting sign-in access in Entra ID (Mode 4) | – | R | **A** | I | – | I |
| Assigning and reviewing the `admin` role | – | – | **A** | R | – | – |
| Periodic user access review | – | – | **A** | R | C | – |
| Off-boarding: deleting users / revoking access | – | R | **A** | R | I | – |
| Creating teams, inviting members, granting manager / ADLC-trainer roles | – | – | C | I | **A/R** | I |
| Choosing a team's access mode (`restricted` / `transparent`) | – | – | C | I | **A/R** | I |
| Acknowledging the team disclosure notice | – | – | – | – | I | **A/R** |
| Creating, rotating and revoking own API keys | – | – | C | I | – | **A/R** |
| Keeping `log-hub.local.json` (API key) out of version control | – | – | C | – | – | **A/R** |

## 5. Data protection

| Activity | Maintainers | Op. IT | Op. Security | LH Admin | Team Owner | End User |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Defining which projects may be connected | – | – | **A** | C | C | R |
| Accepting the data-collection notice | – | – | I | – | – | **A/R** |
| Setting session retention (`SESSION_RETENTION_DAYS`) | – | R | **A** | C | – | I |
| Encryption at rest of host volumes and backups | – | **A/R** | C | – | – | – |
| Restricting what Claude Code may read (Claude Code `permissions.deny` rules) | C | – | C | – | C | **A/R** |
| Avoiding secrets in prompts and transcripts | – | – | C | – | – | **A/R** |
| Deleting own sessions / own account | – | – | – | I | – | **A/R** |
| Handling data-subject requests (access, erasure) | – | C | **A** | R | – | I |

## 6. Security incidents and vulnerabilities

| Activity | Maintainers | Op. IT | Op. Security | LH Admin | Team Owner | End User |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Reporting a suspected vulnerability in the product | I | R | **A** | R | R | R |
| Analysing and fixing product vulnerabilities, publishing a fixed release | **A/R** | I | C | I | – | – |
| Deploying security fixes | I | **A/R** | C | I | – | – |
| Incident response on the operator installation | C | R | **A** | R | I | I |
| Revoking compromised API keys or sessions | – | C | **A** | R | – | R |
| Rotating compromised infrastructure secrets | – | **A/R** | C | I | – | – |

## 7. Hook on developer machines

| Activity | Maintainers | Op. IT | Op. Security | LH Admin | Team Owner | End User |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Hook functionality and compatibility across versions | **A/R** | – | I | I | – | I |
| Installing the hook in a project | – | – | I | – | I | **A/R** |
| Upgrading the hook when the Hook State page reports it outdated | – | – | – | I | I | **A/R** |
| Resolving hook recommendations and upload errors | C | – | – | C | – | **A/R** |
| Uninstalling the hook from a project | – | – | – | – | – | **A/R** |

## Notes

- The project maintainers have no access to operator installations or data unless the operator explicitly
  grants it for support purposes.
- Where the operator is a single organisation without separate IT and Security functions, the
  **Operator IT** and **Operator Security** columns may be held by the same person.
