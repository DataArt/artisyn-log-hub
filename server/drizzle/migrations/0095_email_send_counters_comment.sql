-- Comments only: the strict-managed email limit keys anonymous requests by a sha256 of the client
-- IP (the value can come from a client-controlled X-Forwarded-For), not by the IP itself.
-- No schema or data change; re-runnable.

COMMENT ON TABLE email_send_counters IS 'strict-managed email limit: one fixed one-hour window per key (ip:<sha256 of the client IP> or admin:<user id>), shared by all cluster workers';
