import { closeOracle } from './oracle';
import { casesOf } from './registry';
import { ContractContext, callable, runCase } from './run-case';

describe('contract F12 team-repos', () => {
  const ctx = new ContractContext();
  afterAll(() => closeOracle());
  it.each(callable(casesOf('F12')))('$id', (c) => runCase(c, ctx));
});
