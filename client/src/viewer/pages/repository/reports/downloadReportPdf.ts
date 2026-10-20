import { useState } from 'react';
import type { ReactElement } from 'react';
import { pdf } from '@react-pdf/renderer';
import type { DocumentProps } from '@react-pdf/renderer';

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Defer cleanup: revoking the blob URL or removing the anchor synchronously
  // right after click() can race the browser's download start in some
  // environments, silently dropping the download.
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

// Shared "generate PDF and download it" hook for every report document.
// `buildDoc` must return the actual <Document> element (call the PDF
// component directly rather than as JSX — pdf() requires that exact type).
export function useReportPdfDownload(
  buildDoc: () => ReactElement<DocumentProps>,
  filename: string,
) {
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function handleDownload() {
    setDownloadError(null);
    try {
      const blob = await pdf(buildDoc()).toBlob();
      triggerBlobDownload(blob, filename);
    } catch (err) {
      // PDF generation runs synchronously inside this async handler — without
      // this catch, a rendering failure fails silently: no download, no
      // error, indistinguishable from "still working" (see the PDF export notes in the KB).
      setDownloadError(
        err instanceof Error ? err.message : 'Failed to generate PDF',
      );
    }
  }

  return { downloadError, handleDownload };
}
