# Large sessions open fast and no longer crash the server

- Session logs are loaded in compressed parts: the root transcript first, each sub-agent only when a view needs it, and unchanged parts come from the browser cache. The Session Map uses the same parts instead of one huge download.
- The server streams log answers with bounded memory and paces its background rebuilds by CPU load, so a big session no longer kills a worker on small hosts such as a Raspberry Pi.
- Hook 3.2.0 skips files that did not change, re-sends uploads the server failed to process, and checks upload integrity with a content hash.
