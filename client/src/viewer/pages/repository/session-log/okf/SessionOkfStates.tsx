/**
 * The loading state of the OKF tabs (`SessionOkfTab`, `RepoOkfTab`): a skeleton in the shape of
 * the view — summary line, the Versions / Wrong format row, then Hot files and Explorer.
 */
import { Skeleton } from '@/ui/skeleton';

export function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-4" data-testid="okf-loading">
      <Skeleton className="h-6 w-full" />
      <div className="flex gap-3">
        <Skeleton className="h-10 flex-1" />
        <Skeleton className="h-10 flex-1" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
