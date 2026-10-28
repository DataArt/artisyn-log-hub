// The contract registry (docs/qaa-overview/scenarios/05 §2.7).
//
// Each family lives in its own file `registry/f<NN>-<family>.ts` exporting a `ContractFamily`;
// this index only collects them. Adding a family = one import + one array entry below, plus its
// spec `f<NN>.contract-spec.ts` (see test/contract/README.md).
//
// Like the oracle, nothing under registry/ imports from src/** (types excepted).
import type {
  CallCase,
  ContractCase,
  ContractFamily,
  RouteKey,
} from '../types';
import { f01Infra } from './f01-infra';
import { f02Account } from './f02-account';
import { f03AuthModes } from './f03-auth-modes';
import { f04ApiKeys } from './f04-api-keys';
import { f05UserSettings } from './f05-user-settings';
import { f06AdminUsers } from './f06-admin-users';
import { f07AdminRegistrations } from './f07-admin-registrations';
import { f08AdminReposTeams } from './f08-admin-repos-teams';
import { f09AdminUploadQueue } from './f09-admin-upload-queue';
import { f10TeamsCore } from './f10-teams-core';
import { f11TeamMembers } from './f11-team-members';
import { f12TeamRepos } from './f12-team-repos';
import { f13Invitations } from './f13-invitations';
import { f14Repositories } from './f14-repositories';
import { f15Ingest } from './f15-ingest';
import { f16PostTurn } from './f16-post-turn';
import { f17Sessions } from './f17-sessions';
import { f18SessionDeleteRetention } from './f18-session-delete-retention';
import { f19ChangeSurface } from './f19-change-surface';
import { f20Analytics } from './f20-analytics';
import { f21Reports } from './f21-reports';
import { f22PricingToolVersions } from './f22-pricing-tool-versions';
import { f23ExportImport } from './f23-export-import';
import { f24ToolMonitoring } from './f24-tool-monitoring';

/** Every family, in F01..F24 order. */
export const FAMILIES: readonly ContractFamily[] = [
  f01Infra,
  f02Account,
  f03AuthModes,
  f04ApiKeys,
  f05UserSettings,
  f06AdminUsers,
  f07AdminRegistrations,
  f08AdminReposTeams,
  f09AdminUploadQueue,
  f10TeamsCore,
  f11TeamMembers,
  f12TeamRepos,
  f13Invitations,
  f14Repositories,
  f15Ingest,
  f16PostTurn,
  f17Sessions,
  f18SessionDeleteRetention,
  f19ChangeSurface,
  f20Analytics,
  f21Reports,
  f22PricingToolVersions,
  f23ExportImport,
  f24ToolMonitoring,
];

/** All rows of all families. */
export function allCases(): ContractCase[] {
  return FAMILIES.flatMap((f) => f.cases);
}

/** The rows of one family, for its `it.each`; throws on an unknown family id. */
export function casesOf(familyId: string): ContractCase[] {
  const family = FAMILIES.find((f) => f.id === familyId);
  if (!family) {
    throw new Error(
      `Unknown contract family "${familyId}" — register it in test/contract/registry/index.ts`,
    );
  }
  return family.cases;
}

/** The set of `METHOD /path` keys the registry covers (excluded rows included). */
export function registryRoutes(): Set<RouteKey> {
  return new Set(allCases().map((c) => c.route));
}

/** A calling row by id (for `sameExpectedAs`); throws when missing or excluded. */
export function findCallCase(id: string): CallCase {
  const found = allCases().find((c) => c.id === id);
  if (!found) throw new Error(`No contract row with id "${id}"`);
  if (found.kind === 'excluded') {
    throw new Error(
      `Contract row "${id}" is excluded and cannot be a sameExpectedAs target`,
    );
  }
  return found;
}
