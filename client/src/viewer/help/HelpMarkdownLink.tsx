import type { ComponentProps, MouseEvent } from 'react';
import type { ExtraProps } from 'react-markdown';
import { parseHelpHref } from './help-links';

export type HelpNavigate = (slug: string, anchor?: string) => void;

type HelpMarkdownLinkProps = ComponentProps<'a'> &
  ExtraProps & {
    knownSlugs: ReadonlySet<string>;
    onNavigate: HelpNavigate;
  };

function decodeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
}

/**
 * `<a>` renderer for help articles (DD-14): links between help pages switch the
 * article inside the modal, `#anchor` links scroll the content pane, external
 * links open in a new tab and carry a trailing ↗.
 */
export function HelpMarkdownLink({
  href,
  children,
  knownSlugs,
  onNavigate,
  node: _node,
  ...rest
}: HelpMarkdownLinkProps) {
  if (!href) return <a {...rest}>{children}</a>;
  const parsed = parseHelpHref(href, knownSlugs);

  if (parsed.kind === 'external') {
    return (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
        {' ↗'}
      </a>
    );
  }

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (parsed.kind === 'anchor') {
      document
        .getElementById(decodeAnchor(parsed.anchor))
        ?.scrollIntoView({ block: 'start' });
    } else if (parsed.kind === 'page') {
      onNavigate(
        parsed.slug,
        parsed.anchor === undefined ? undefined : decodeAnchor(parsed.anchor),
      );
    } else {
      console.warn(`[help] unknown help page: ${href}`);
    }
  };

  return (
    <a {...rest} href={href} onClick={handleClick}>
      {children}
    </a>
  );
}
