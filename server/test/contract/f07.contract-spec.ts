import { closeOracle } from './oracle';
import { casesOf } from './registry';
import { ContractContext, callable, runCase } from './run-case';

describe('contract F07 admin-registrations', () => {
  const ctx = new ContractContext();
  afterAll(() => closeOracle());
  it.each(callable(casesOf('F07')))('$id', (c) => runCase(c, ctx));
});
