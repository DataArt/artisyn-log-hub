import { closeOracle } from './oracle';
import { casesOf } from './registry';
import { ContractContext, callable, runCase } from './run-case';

describe('contract F01 infra', () => {
  const ctx = new ContractContext();

  afterAll(() => closeOracle());
  it.each(callable(casesOf('F01')))('$id', (c) => runCase(c, ctx));
});
