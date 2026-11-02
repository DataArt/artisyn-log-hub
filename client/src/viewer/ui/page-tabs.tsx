import type * as React from 'react';
import { tabTestId } from '../tab-ids';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './tooltip';

interface PageTab {
  value: string;
  label: string;
  /** When set, hovering the trigger shows it in a light tooltip below the tab. */
  description?: string;
}

interface PageTabsProps {
  tabs: PageTab[];
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
  leftActions?: React.ReactNode;
  /**
   * When set, each tab trigger gets `data-testid="tab-<testIdGroup>-<value>"`, so tests
   * and scenario tours can address a tab by its id rather than its label.
   */
  testIdGroup?: string;
}

function PageTabs({
  tabs,
  value,
  onValueChange,
  children,
  className,
  actions,
  leftActions,
  testIdGroup,
}: PageTabsProps) {
  return (
    <Tabs value={value} onValueChange={onValueChange} className={className}>
      <div className="flex items-center border-b border-border px-4">
        {leftActions != null && <div className="pr-2">{leftActions}</div>}
        <TooltipProvider>
          <TabsList variant="line">
            {tabs.map((tab) => {
              const testId =
                testIdGroup != null
                  ? tabTestId(testIdGroup, tab.value)
                  : undefined;
              if (tab.description == null) {
                return (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    data-testid={testId}
                  >
                    {tab.label}
                  </TabsTrigger>
                );
              }
              return (
                <Tooltip key={tab.value}>
                  {/* The tab trigger wraps the tooltip trigger (not the other way round), so
                      the tab's `data-state="active"` wins over the tooltip's on the one button. */}
                  <TabsTrigger value={tab.value} data-testid={testId} asChild>
                    <TooltipTrigger>{tab.label}</TooltipTrigger>
                  </TabsTrigger>
                  <TooltipContent
                    variant="light"
                    side="bottom"
                    className="max-w-[280px]"
                  >
                    {tab.description}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </TabsList>
        </TooltipProvider>
        {actions != null && <div className="ml-auto pl-2">{actions}</div>}
      </div>
      {children}
    </Tabs>
  );
}

export type { PageTab };
export { PageTabs };
export { TabsContent as PageTabsContent };
