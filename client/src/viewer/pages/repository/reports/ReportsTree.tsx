import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  REPORT_CATEGORIES,
  findCategoryForReport,
  type ReportId,
} from './report-catalog';

const STORAGE_KEY = 'artisyn:reportsTreeState';

function loadCollapseState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

interface Props {
  selectedReportId: ReportId | null;
  onSelectReport: (id: ReportId) => void;
}

export function ReportsTree({ selectedReportId, onSelectReport }: Props) {
  const [collapsed, setCollapsed] =
    useState<Record<string, boolean>>(loadCollapseState);

  // Always keep the selected report's own category expanded (e.g. after a
  // deep-link with report=<id> lands in a category the user had collapsed).
  useEffect(() => {
    if (!selectedReportId) return;
    const category = findCategoryForReport(selectedReportId);
    if (category && collapsed[category.id]) {
      setCollapsed((prev) => {
        const next = { ...prev, [category.id]: false };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    }
    // Intentionally excludes `collapsed` — re-running only when the selected
    // report changes, not on every collapse/expand, avoids re-expanding a
    // category the user just chose to collapse.
  }, [selectedReportId]);

  function toggleCategory(categoryId: string, containsSelected: boolean) {
    setCollapsed((prev) => {
      const isCurrentlyCollapsed = prev[categoryId] ?? false;
      // Clicking the selected report's own expanded category is a no-op —
      // it should never disappear behind its own selection.
      if (!isCurrentlyCollapsed && containsSelected) return prev;
      const next = { ...prev, [categoryId]: !isCurrentlyCollapsed };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  return (
    <nav
      className="flex flex-col gap-1 overflow-y-auto p-2"
      aria-label="Reports"
    >
      <span className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Reports
      </span>
      {REPORT_CATEGORIES.map((category) => {
        const isCollapsed = collapsed[category.id] ?? false;
        const containsSelected = category.reports.some(
          (r) => r.id === selectedReportId,
        );
        return (
          <div key={category.id}>
            <button
              onClick={() => toggleCategory(category.id, containsSelected)}
              className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm font-medium text-foreground/80 hover:bg-accent/50"
            >
              {isCollapsed ? (
                <ChevronRight className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
              {category.title}
            </button>
            {!isCollapsed && (
              <div className="flex flex-col gap-0.5 py-0.5 pl-2">
                {category.reports.map((report) => (
                  <button
                    key={report.id}
                    onClick={() => onSelectReport(report.id)}
                    className={cn(
                      'flex items-center gap-2 rounded border-l-2 px-2 py-1.5 text-left text-sm',
                      report.id === selectedReportId
                        ? 'border-primary bg-accent font-medium text-accent-foreground'
                        : 'border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    )}
                  >
                    {report.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
