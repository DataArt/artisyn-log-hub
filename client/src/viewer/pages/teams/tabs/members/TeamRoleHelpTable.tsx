import {
  ROLE_HELP_ROWS,
  ROLE_HELP_TITLE,
} from '../../../../lib/access-mode-copy';

/**
 * The inline helper under the member list: one row
 * per role spelling out what it grants in a restricted team. Rendered from
 * `ROLE_HELP_ROWS` so the copy cannot drift from what the tests assert.
 */
export function TeamRoleHelpTable() {
  return (
    <div
      className="p-4 border border-border rounded-md bg-card"
      data-testid="role-help-table"
    >
      <p className="mb-2 text-sm font-medium">{ROLE_HELP_TITLE}</p>
      <dl className="flex flex-col gap-1.5">
        {ROLE_HELP_ROWS.map(([role, grants]) => (
          <div key={role} className="flex gap-2 text-xs">
            <dt className="w-28 shrink-0 font-medium">{role}</dt>
            <dd className="text-muted-foreground">{grants}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
