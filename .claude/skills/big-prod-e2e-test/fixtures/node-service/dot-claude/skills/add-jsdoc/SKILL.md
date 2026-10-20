---
name: add-jsdoc
description: Add JSDoc comments to every exported function in a given JavaScript file. Use when asked to document a JavaScript module or run /add-jsdoc <file>.
---

# Add JSDoc

The argument is the path of a JavaScript file (for example `src/calc.js`).

1. Read the given file.
2. For every exported function, add a JSDoc block directly above it if it has none:
   - a one-line summary in the imperative mood;
   - a `@param` tag for every parameter, with its type and a short description;
   - a `@returns` tag describing the return value;
   - a `@throws` tag only if the function throws explicitly.
3. Leave non-exported functions and the function bodies unchanged.
4. Do not change any other file, and do not install packages.
5. Reply with the list of functions you documented.
