/**
 * Table test for docs/knowledgebase/algorithms/okf-metadata.md. A row's `kind` picks the function
 * (see the doc's Examples preamble): `versionHint` → `okfVersionHint`, `staleAfter` →
 * `parseStaleAfter`, `flags` → `articleMetaFlags`, `summary` → `bundleMetaSummary`. Bundles default
 * to root `kb`, index `kb/index.md`, not ignored; files to `ignored: false`, `size: 1` and a dummy
 * hash, since none of these enter the rules.
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import {
  articleMetaFlags,
  bundleMetaSummary,
  okfVersionHint,
  parseStaleAfter,
} from './okf-metadata';
import type {
  OkfSnapshotBundle,
  OkfSnapshotFile,
  OkfSnapshotFileMeta,
} from './okf-snapshot';

interface FileSpec {
  path: string;
  meta?: OkfSnapshotFileMeta;
}

interface BundleSpec {
  root?: string;
  index?: string;
  okfVersion?: string;
  title?: string;
  description?: string;
  files: FileSpec[];
}

interface MetadataInput {
  okfVersion?: string;
  value?: string;
  refMs?: number;
  file?: FileSpec;
  bundle?: BundleSpec;
}

const DUMMY_HASH = '0'.repeat(64);

function toFile(spec: FileSpec): OkfSnapshotFile {
  return {
    path: spec.path,
    ignored: false,
    size: 1,
    hash: DUMMY_HASH,
    ...(spec.meta !== undefined ? { meta: spec.meta } : {}),
  };
}

function toBundle(spec: BundleSpec | undefined): OkfSnapshotBundle {
  const { files = [], root = 'kb', index, ...fields } = spec ?? { files: [] };
  return {
    ...fields,
    root,
    index: index ?? `${root}/index.md`,
    ignored: false,
    files: files.map(toFile),
  };
}

const rows = loadExamples<MetadataInput, unknown>('okf-metadata');

it.each(rows)('$id', ({ kind, input, expected }) => {
  switch (kind) {
    case 'versionHint':
      expect({ hint: okfVersionHint(input.okfVersion) }).toEqual(expected);
      break;
    case 'staleAfter':
      expect({ ms: parseStaleAfter(input.value ?? '') }).toEqual(expected);
      break;
    case 'flags': {
      if (input.file === undefined) throw new Error('flags row without file');
      expect(
        articleMetaFlags(
          toFile(input.file),
          toBundle(input.bundle),
          input.refMs ?? 0,
        ),
      ).toEqual(expected);
      break;
    }
    case 'summary':
      expect(
        bundleMetaSummary(toBundle(input.bundle), input.refMs ?? 0),
      ).toEqual(expected);
      break;
    default:
      throw new Error(`unknown kind ${String(kind)}`);
  }
});
