import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { MainNav } from '../pages/main/MainNav';
import { AppLeftNav } from './AppLeftNav';
import { useDraggableWidth } from '../hooks/useDraggableWidth';

export function AppShell({ children }: { children: ReactNode }) {
  const [isCollapsed, setIsCollapsed] = useState<boolean>(
    () => localStorage.getItem('artisyn:leftNavCollapsed') === 'true',
  );

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('artisyn:leftNavCollapsed', String(next));
      return next;
    });
  }, []);

  const { width: leftNavWidth, onMouseDown: handleNavDragStart } =
    useDraggableWidth({
      storageKey: 'artisyn:leftNavWidth',
      defaultWidth: 320,
      minWidth: 150,
      getMaxWidth: () => window.innerWidth * 0.8,
    });

  const effectiveWidth = isCollapsed
    ? 48
    : Math.min(leftNavWidth, window.innerWidth * 0.8);

  return (
    <div className="flex flex-col h-screen">
      <MainNav />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left nav wrapper */}
        <div
          style={{ width: effectiveWidth, transition: 'width 200ms ease' }}
          className="relative shrink-0 flex flex-col overflow-hidden"
        >
          {/* Toggle button row */}
          <div className="flex items-center justify-end shrink-0 px-1 py-1 border-b border-border/40">
            <button
              onClick={toggleCollapse}
              title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="flex items-center justify-center p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              {isCollapsed ? (
                <ChevronRight className="size-4" />
              ) : (
                <ChevronLeft className="size-4" />
              )}
            </button>
          </div>

          {/* Scrollable nav content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <AppLeftNav isCollapsed={isCollapsed} />
          </div>
        </div>

        {/* Drag handle */}
        <div
          className="w-[5px] shrink-0 bg-border hover:bg-primary/30 transition-colors"
          style={{ cursor: isCollapsed ? 'default' : 'col-resize' }}
          onMouseDown={isCollapsed ? undefined : handleNavDragStart}
        />

        {/* Main content */}
        <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
