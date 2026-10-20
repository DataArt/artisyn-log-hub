import { closeOracle } from './oracle';
import { casesOf } from './registry';
import { ContractContext, callable, runCase } from './run-case';

describe('contract F14 repositories', () => {
  const ctx = new ContractContext();
  afterAll(() => closeOracle());
  it.each(callable(casesOf('F14')))('$id', (c) => runCase(c, ctx));
});
