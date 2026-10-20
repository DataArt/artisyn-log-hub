import * as fs from 'fs';
import { join } from 'path';
import { closeOracle } from './oracle';
import { casesOf } from './registry';
import { F09_STAGED_FILE } from './registry/f09-admin-upload-queue';
import { ContractContext, callable, runCase } from './run-case';

describe('contract F09 admin-upload-queue', () => {
  const ctx = new ContractContext();

  // World row #1's staged file, in the run's temp UPLOAD_QUEUE_DIR. Rewritten before every row:
  // `DELETE .../failed` unlinks the staged files of the rows it removes.
  beforeEach(() => {
    const dir = process.env.UPLOAD_QUEUE_DIR;
    if (!dir)
      throw new Error(
        'UPLOAD_QUEUE_DIR is not set by the contract global setup',
      );
    fs.writeFileSync(join(dir, F09_STAGED_FILE.name), F09_STAGED_FILE.text);
  });

  afterAll(() => closeOracle());
  it.each(callable(casesOf('F09')))('$id', (c) => runCase(c, ctx));
});
