import { useMemo } from 'react';
import { renderMarkdown } from '../lib/markdown.ts';

/** The renderer escapes before it formats, so assistant output cannot inject
 *  markup. See lib/markdown.ts. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={className ? `md ${className}` : 'md'} dangerouslySetInnerHTML={{ __html: html }} />;
}
