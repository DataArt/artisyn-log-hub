import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download } from 'lucide-react';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { helpDownloadFileName, helpNav } from './articles/index';

const allArticles = helpNav.flatMap((section) => section.articles);
const defaultSlug = allArticles[0]?.slug ?? '';

interface HelpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpModal({ open, onOpenChange }: HelpModalProps) {
  const [activeSlug, setActiveSlug] = useState(defaultSlug);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const activeArticle = allArticles.find((a) => a.slug === activeSlug);

  useEffect(() => {
    if (open) {
      setActiveSlug(defaultSlug);
    }
  }, [open]);

  useEffect(() => {
    if (!activeSlug) return;
    setLoading(true);
    setContent(null);
    fetch(`/help/${activeSlug}.md`)
      .then((res) =>
        res.ok ? res.text() : Promise.reject(new Error('not found')),
      )
      .then((text) => setContent(text))
      .catch(() => setContent(null))
      .finally(() => setLoading(false));
  }, [activeSlug]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[90vw] max-w-[1100px] h-[85vh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-4 py-3 border-b flex-shrink-0">
          <DialogTitle>Help</DialogTitle>
          <DialogDescription className="sr-only">
            Browse help articles and the changelog
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col sm:flex-row flex-1 min-h-0 h-full overflow-hidden">
          {/* Left sidebar */}
          <nav className="w-full sm:w-[220px] sm:flex-shrink-0 overflow-y-auto border-b sm:border-b-0 sm:border-r border-border bg-muted/40 py-3">
            {helpNav.map((section) => (
              <div key={section.section} className="mb-4">
                <p className="px-4 mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  {section.section}
                </p>
                <ul>
                  {section.articles.map((article) => {
                    const isActive = article.slug === activeSlug;
                    return (
                      <li key={article.slug}>
                        <button
                          type="button"
                          className={
                            isActive
                              ? 'w-full text-left px-4 py-1.5 text-sm bg-blue-50 border-l-[3px] border-blue-500 text-blue-700 font-semibold'
                              : 'w-full text-left px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent cursor-pointer border-l-[3px] border-transparent'
                          }
                          onClick={() => setActiveSlug(article.slug)}
                        >
                          {article.title}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          {/* Right content pane */}
          <div className="flex-1 overflow-y-auto p-6">
            {loading ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : content !== null ? (
              <div className="prose prose-sm max-w-none">
                {activeArticle?.downloadable && (
                  <div className="not-prose flex justify-end mb-2">
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={`/help/${activeArticle.slug}.md`}
                        download={helpDownloadFileName(activeArticle.slug)}
                      >
                        <Download className="size-4" />
                        Download .md
                      </a>
                    </Button>
                  </div>
                )}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {content}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="text-muted-foreground">Article not found.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
