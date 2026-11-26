# Session tags from OTEL resource attributes

Session context became universal session tags (key=value with a source), fed by user attributes in
`OTEL_RESOURCE_ATTRIBUTES` instead of the hook config; tags show on the repository and the session,
and sessions and cost can be filtered and grouped by tag.
