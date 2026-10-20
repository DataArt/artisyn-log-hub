export function shortenClaudeMdPath(path: string, allPaths: string[]): string {
  const normalized = path.replace(/\\/g, '/');
  const normAll = allPaths.map((p) => p.replace(/\\/g, '/'));
  const splitAll = normAll.map((p) => p.split('/'));
  const refParts = splitAll[0];
  let commonLen = refParts.length - 1;
  for (const parts of splitAll.slice(1)) {
    let i = 0;
    while (i < commonLen && i < parts.length - 1 && parts[i] === refParts[i])
      i++;
    commonLen = i;
  }
  const stripped = normalized.split('/').slice(commonLen).join('/');
  return stripped || normalized.split('/').pop() || path;
}

export function getRuleShortName(p: string): string {
  const norm = p.replace(/\\/g, '/');
  return norm.split('/').pop()?.replace(/\.md$/i, '') ?? norm;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
