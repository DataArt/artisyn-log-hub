// F03 — routes that exist only in another auth mode (docs/qaa-overview/scenarios/05 §F03). The
// contract suite runs in `password-confirm`, where AuthModeGuard answers 404 and writes nothing.
// The positive paths of `none` (identify) are covered by the mode-A scenarios
// (tests/scenarios/auth/*); Azure needs real Microsoft and is out of scope.
import type { ContractFamily } from '../types';

export const f03AuthModes: ContractFamily = {
  id: 'F03',
  name: 'auth-modes',
  cases: [
    {
      id: 'F03-identify-404',
      route: 'POST /api/v1/auth/identify',
      actor: 'anon',
      body: { email: '@owner.email' },
      expect: { status: 404 },
    },
    {
      id: 'F03-azure-404',
      route: 'GET /api/v1/auth/azure',
      actor: 'anon',
      expect: { status: 404 },
    },
    {
      id: 'F03-azure-callback-404',
      route: 'GET /api/auth/callback',
      actor: 'anon',
      query: { code: 'fake', state: 'fake' },
      expect: { status: 404 },
    },
    {
      id: 'F03-azure-callback-positive',
      route: 'GET /api/auth/callback',
      kind: 'excluded',
      reason:
        'the positive callback needs a real Azure AD tenant (05 §3, §5 risk 1); only the ' +
        'mode guard is checked above',
    },
  ],
};
