/**
 * Saves a text built in the browser as a Markdown file: Blob → object URL → a temporary
 * `<a download>` click. The URL is revoked on the next tick, after the click has started the
 * download.
 */
export function downloadTextFile(fileName: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
