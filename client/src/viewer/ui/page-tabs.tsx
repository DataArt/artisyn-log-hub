import type * as React from 'react';
import { tabTestId } from '../tab-ids';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

interface PageTab {
  value: string;
  label: string;
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
        <TabsList variant="line">
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              data-testid={
                testIdGroup != null
                  ? tabTestId(testIdGroup, tab.value)
                  : undefined
              }
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {actions != null && <div className="ml-auto pl-2">{actions}</div>}
      </div>
      {children}
    </Tabs>
  );
}

export { PageTabs };
export { TabsContent as PageTabsContent };
