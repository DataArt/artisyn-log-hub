import { closeOracle } from './oracle';
import { casesOf } from './registry';
import { ContractContext, callable, runCase } from './run-case';

describe('contract F11 team-members', () => {
  const ctx = new ContractContext();
  afterAll(() => closeOracle());
  it.each(callable(casesOf('F11')))('$id', (c) => runCase(c, ctx));
});
