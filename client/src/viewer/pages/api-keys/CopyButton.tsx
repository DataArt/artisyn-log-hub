import { Check, Copy } from 'lucide-react';

export function CopyButton({
  copied,
  copy,
}: {
  copied: boolean;
  copy: () => void;
}) {
  return (
    <button
      className="shrink-0 p-2 rounded border border-border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
      onClick={copy}
      title="Copy"
    >
      {copied ? (
        <Check className="size-3.5 text-green-600" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}
