# Hook installer no longer downgrades the hook by accident

A stale cached installer (`npx … upgrade` without the version suffix) now fetches the server's current installer instead of installing its older bundled hook over a newer one; a real downgrade asks for confirmation first.
