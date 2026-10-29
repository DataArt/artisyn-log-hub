import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
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
import { HelpMarkdownLink } from './HelpMarkdownLink';

/** The page the modal opens on (DD-13) — not simply the first menu entry. */
const DEFAULT_HELP_SLUG = 'getting-started';

const allArticles = helpNav.flatMap((section) => section.articles);
const knownSlugs: ReadonlySet<string> = new Set(
  allArticles.map((article) => article.slug),
);
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSlug];

interface HelpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpModal({ open, onOpenChange }: HelpModalProps) {
  const [activeSlug, setActiveSlug] = useState(DEFAULT_HELP_SLUG);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Heading id to scroll to once the next article has rendered (DD-15). */
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const contentPaneRef = useRef<HTMLDivElement>(null);
  const activeArticle = allArticles.find((a) => a.slug === activeSlug);

  useEffect(() => {
    if (open) {
      setPendingAnchor(null);
      setActiveSlug(DEFAULT_HELP_SLUG);
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

  // After an article renders: jump to the requested heading, or to the top
  // when there is none (or the heading does not exist).
  useEffect(() => {
    if (content === null) return;
    const target = pendingAnchor
      ? document.getElementById(pendingAnchor)
      : null;
    if (target) {
      target.scrollIntoView({ block: 'start' });
    } else if (contentPaneRef.current) {
      contentPaneRef.current.scrollTop = 0;
    }
  }, [content, pendingAnchor]);

  const openArticle = useCallback((slug: string, anchor?: string) => {
    setPendingAnchor(anchor ?? null);
    setActiveSlug(slug);
  }, []);

  const markdownComponents = useMemo<Components>(
    () => ({
      a: (props) => (
        <HelpMarkdownLink
          {...props}
          knownSlugs={knownSlugs}
          onNavigate={openArticle}
        />
      ),
    }),
    [openArticle],
  );

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
                          onClick={() => openArticle(article.slug)}
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
          <div ref={contentPaneRef} className="flex-1 overflow-y-auto p-6">
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
                <ReactMarkdown
                  remarkPlugins={remarkPlugins}
                  rehypePlugins={rehypePlugins}
                  components={markdownComponents}
                >
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
