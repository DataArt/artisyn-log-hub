# Old server log files are cleaned up automatically

- The server deletes its own old operational logs (application logs after 5 days, SQL logs after 3, all of them capped at 100 MB) at startup and every hour; `LOG_RETENTION_*` settings change the limits. Session data is not affected.
- New guide "Quick setup for a small team": installing Log Hub on one VM in a company network in about 15 minutes.
