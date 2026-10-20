import { Loader2 } from 'lucide-react';

export function LazyFallback({ fullScreen }: { fullScreen?: boolean }) {
  return (
    <div
      className={
        fullScreen
          ? 'flex h-screen items-center justify-center bg-background text-foreground font-sans'
          : 'flex h-full items-center justify-center bg-background text-foreground font-sans'
      }
    >
      <Loader2 className="animate-spin size-6" />
    </div>
  );
}
