import { closeOracle } from './oracle';
import { casesOf } from './registry';
import { ContractContext, callable, runCase } from './run-case';

describe('contract F19 change-surface', () => {
  const ctx = new ContractContext();
  afterAll(() => closeOracle());
  it.each(callable(casesOf('F19')))('$id', (c) => runCase(c, ctx));
});
