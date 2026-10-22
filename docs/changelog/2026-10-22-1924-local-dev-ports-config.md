# Per-developer Log Hub settings in log-hub.local.json

The hooks installer now writes `serverUrl` and the OTEL receiver port into the gitignored `.artisyn/config/log-hub.local.json` instead of the tracked `log-hub.json`, so each developer keeps their own ports without dirtying the shared config.
