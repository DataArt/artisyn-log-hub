# Hook: no false "project-only OTEL setting" warning

The hook (2.30.4) no longer warns that OTEL is configured only for the project when the only
project-level key is `OTEL_RESOURCE_ATTRIBUTES`, which is meant to be set per repository.
