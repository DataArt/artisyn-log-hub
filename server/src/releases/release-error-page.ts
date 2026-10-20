import type { Response } from 'express';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Writes a minimal, recipient-facing HTML refusal page for the public release
 * download route.
 *
 * The redeem controller must **not** throw an `HttpException`: the global
 * `HttpExceptionFilter` (`server/src/main.ts`) renders JSON for every one of
 * them, and the person holding a release link is a human in a browser, not an
 * API client. So the controller calls this helper and returns instead.
 *
 * The page carries no stack trace, no filesystem path and no partial file
 * body. Callers use exactly this copy:
 *
 * | Case | Status | Title | Detail |
 * |---|---|---|---|
 * | Pattern or signature fails | 403 | `Invalid download link` | `This download link is not valid. Ask the administrator who sent it for a new one.` |
 * | Signature valid, `exp` in the past | 410 | `Link expired` | `This download link has expired. Download links are valid for 24 hours. Ask the administrator who sent it for a new one.` |
 * | Valid, file absent from disk | 404 | `File no longer available` | `The release this link points to is no longer on this server. Ask the administrator who sent it for a current link.` |
 */
export function sendReleaseErrorPage(
  res: Response,
  status: number,
  title: string,
  detail: string,
): void {
  const safeTitle = escapeHtml(title);
  const safeDetail = escapeHtml(detail);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f9;color:#1f2328;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
<main style="max-width:32rem;padding:2rem;text-align:center;">
<h1 style="margin:0 0 0.75rem;font-size:1.25rem;font-weight:600;">${safeTitle}</h1>
<p style="margin:0;font-size:0.95rem;line-height:1.5;color:#57606a;">${safeDetail}</p>
</main>
</body>
</html>
`;

  res.status(status).type('html').send(html);
}
