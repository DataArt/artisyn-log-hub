import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  callUuid: string;
  endpoint: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();
