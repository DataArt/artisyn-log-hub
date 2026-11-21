/**
 * The whole OKF tab when there is no KB snapshot: one line with a link to the hook install page.
 * No numbers are shown — without a snapshot the KB folders are unknown.
 */
import { useNavigate } from 'react-router-dom';
import { routes } from '../../../../hooks/useHashRoute';
import { OKF_NO_SNAPSHOT_LINK, OKF_NO_SNAPSHOT_TEXT } from './okf-view-text';

export function OkfNoSnapshotLine() {
  const navigate = useNavigate();
  return (
    <div data-testid="okf-no-snapshot" className="text-sm text-foreground">
      {OKF_NO_SNAPSHOT_TEXT}{' '}
      <button
        type="button"
        onClick={() => {
          void navigate(routes.apiKeys);
        }}
        className="font-medium text-primary underline underline-offset-2"
      >
        {OKF_NO_SNAPSHOT_LINK}
      </button>
    </div>
  );
}
