# SMTP only where the auth mode needs it

- No more "SMTP connection warm-up failed" warnings at startup when SMTP is not configured; modes `none` and `azure-oauth` never touch SMTP.
- In `password` mode SMTP is optional: without it "Forgot password?" is disabled with the hint "SMTP server is not configured".
- In `password-confirm` mode the app refuses to start if the configured SMTP relay is unreachable.
- No built-in SMTP host/port defaults; setup docs describe SMTP per auth mode.
