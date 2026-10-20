# T-108: Open questions

- What exact names should the two `.md` files get, and which convention should they follow (for
  example, `advisor-prompt.md` / `attribution-prompt.md`, or other names consistent with the naming
  conventions already used in `hook/`)?

- How exactly should the `.md` files be packaged together with the hook JS scripts: simply copied
  as additional assets in `npm run build:hooks-installer` / into the dogfooded copy under
  `.artisyn/marketplace/plugins/log-hub-hooks/`, or should their content be embedded into the JS at
  build time (so as not to drag extra files into the installer)?

- Is a simple placeholder substitution mechanism (templating) needed inside the `.md`, or is it
  enough to keep only the unchanging "frame" of the prompt in the `.md` and keep concatenating the
  dynamic sections in the JS code the same way as now?

- Is backward compatibility required for users with an old hook version without the `.md` files
  (for example, if the hook build/install did not deliver the new `.md` file) — is a fallback to
  hardcoded text inside the JS needed in case the file is missing?
