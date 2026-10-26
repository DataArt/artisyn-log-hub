// Jest transform for the TypeScript sources of the repo-local packages (packages/*, e.g.
// @loghub/pricing). Those packages are `"type": "module"` so Node 24 loads their .ts directly at
// runtime, and ts-jest then emits ESM for them, which the CommonJS jest runtime cannot execute.
// This transpiles them to CommonJS instead; their relative imports keep the `.ts` extension,
// which jest resolves as is. Types are checked by `npm run typecheck`, not here.
const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText, sourceMapText } = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2023,
        esModuleInterop: true,
        sourceMap: true,
      },
    });
    return { code: outputText, map: sourceMapText };
  },
};
