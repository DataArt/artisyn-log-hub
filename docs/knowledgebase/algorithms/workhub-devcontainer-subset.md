---
reviewed: no
reviewer: none
---

# Work Hub devcontainer subset

## Purpose

A workspace's container is described by `.devcontainer/devcontainer.json` in its repo. Work Hub
understands a small subset of that format: which image (or Dockerfile) to use, extra environment
variables and a command to run once after the container is created. This rule reads the file and
refuses a definition it cannot honour, with a sentence the user can act on.

## Code

- Implementation: `work-hub/server/src/devcontainer.rs` (`parse` → `ContainerSpec { source:
  ImageSource, container_env, post_create }`; constant `DEFAULT_IMAGE_SENTINEL`). Caller:
  `work-hub/server/src/workspaces/` when the workspace container is created without a checkpoint.
- Twins: none.
- Test: `work-hub/server/tests/algo.rs` (`workhub_devcontainer_subset`), run by `npm run test:algo`
  from `work-hub/`.

## Input and output

The file's text → either the spec, written in the rows as
`{ok: true, source, containerEnv, postCreate}` with `source` one of `{kind: "default"}`,
`{kind: "image", image}` or `{kind: "build", dockerfile, context}`, or an error sentence
(`{ok: false, error}`; the row pins a substring of it).

## Rules

1. The text is JSONC: JSON plus `//` and `/* */` comments and trailing commas. Nothing else is
   relaxed (no unquoted keys, no single quotes). Not parseable → "devcontainer.json is not valid
   JSON: …".
2. The top level must be an object → otherwise "devcontainer.json must contain a JSON object."
3. `image`: a non-blank string, trimmed. `artisyn-work-hub-default` (`DEFAULT_IMAGE_SENTINEL`,
   compared after the trim) means Work Hub's default image (`WORK_HUB_DEFAULT_IMAGE`); any other
   name is an image that must already exist locally. Blank or not a string → "\"image\" must be a
   non-empty string."
4. `build`: an object with a non-blank string `dockerfile` and an optional non-blank string
   `context` (default `"."`); both trimmed and relative to `.devcontainer/`. Not an object →
   "\"build\" must be an object."; no dockerfile → "\"build.dockerfile\" must be a non-empty
   string."
5. Exactly one of `image` and `build` → otherwise "use either \"image\" or \"build\", not both." or
   "needs an \"image\" or a \"build.dockerfile\"." (`null` counts as absent.)
6. `containerEnv` (optional): an object whose values are all strings, kept untouched. A non-string
   value → "\"containerEnv.<key>\" must be a string."; a key that is empty or holds `=` or NUL (or a
   value with NUL) → "\"containerEnv\" has an invalid variable \"<key>\"."; not an object →
   "\"containerEnv\" must be an object of strings."
7. `postCreateCommand` (optional): a string becomes `["sh", "-c", <string>]` (untrimmed); an array
   of strings is the argv as is; a blank string or an empty array means none (`null`). Anything else
   (a non-string item, an object, a number) → "\"postCreateCommand\" must be a string or an array of
   strings."
8. Every other key (`name`, `features`, `forwardPorts`, `remoteUser`, `customizations`, …) is
   ignored.

## Edge cases

- Default sentinel DC-01, also after trimming DC-04; other image DC-02, trimmed DC-03; blank image
  DC-11.
- Build without and with context DC-05, DC-06; missing dockerfile DC-07; build not an object DC-08.
- Both / neither source: DC-09, DC-10.
- containerEnv: strings kept DC-12; number refused DC-13; `=` in the name DC-14; list form DC-15.
- postCreate: string DC-16, array DC-17, blank string DC-18, empty array DC-19, non-string item
  DC-20, object form DC-21.
- JSONC comments and trailing commas DC-22; invalid JSON DC-23, DC-24; top level not an object
  DC-25.
- Unknown keys ignored: DC-01 (`name`), DC-26.

## Examples

`input.json` is the file's text. For a valid file `expected` is the whole result; for an invalid
one `expected.error` is a substring of the error sentence.

Rows (26): [`docs/algorithm-examples/workhub-devcontainer-subset.json`](../../algorithm-examples/workhub-devcontainer-subset.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Sentinel compared before trimming -> DC-04; image not trimmed -> DC-03.
- No default context -> DC-05.
- `image` preferred silently when both are present -> DC-09.
- Non-string env values coerced to strings -> DC-13; `=` allowed in names -> DC-14.
- postCreate string split on spaces instead of `sh -c` -> DC-16; an array joined into a shell
  string -> DC-17; blank string run as a command -> DC-18.
- Strict JSON (no comments / trailing commas) -> DC-22; JSON5-style leniency -> DC-24.
- Unknown keys refused -> DC-26.

## Where the result is visible

`create_failed` with this sentence when a workspace is created (or its container is recreated)
from an unsupported definition; otherwise the image, environment and one-time setup command of the
workspace container.
