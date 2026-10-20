import * as fs from 'fs';
import { join } from 'path';
import { closeOracle } from './oracle';
import { casesOf } from './registry';
import { F01_RELEASE_ZIP } from './registry/f01-infra';
import { ContractContext, callable, runCase } from './run-case';

describe('contract F01 infra', () => {
  const ctx = new ContractContext();

  // The release rows need one zip in the run's temp RELEASES_DIR (set by the global setup).
  beforeAll(() => {
    const dir = process.env.RELEASES_DIR;
    if (!dir)
      throw new Error('RELEASES_DIR is not set by the contract global setup');
    fs.writeFileSync(join(dir, F01_RELEASE_ZIP), 'world-release');
  });

  afterAll(() => closeOracle());
  it.each(callable(casesOf('F01')))('$id', (c) => runCase(c, ctx));
});
