# Less upload and download traffic

- Hook 3.3.0 sends only the new lines of a growing session log instead of the whole file, and falls back to a full upload on anything suspicious or against an older server.
- Large API answers (session OTEL first) are compressed when the browser accepts it.
