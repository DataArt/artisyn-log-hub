import { useState } from 'react';
import {
  buildFileSummary,
  FileRow,
  SectionHeader,
} from './prompt-turn-helpers';
import type { FileAccess } from './types';

interface Props {
  files: FileAccess[];
}

export function PromptTurnFilesSection({ files }: Props) {
  const [catOpen, setCatOpen] = useState<Record<string, boolean>>({});

  if (files.length === 0) return null;

  // Group files by category; 'code' renders first, remaining in declaration order
  const filesByCategory = files.reduce<Record<string, FileAccess[]>>(
    (acc, f) => {
      (acc[f.category] ??= []).push(f);
      return acc;
    },
    {},
  );
  const categoryOrder = [
    'code',
    ...Object.keys(filesByCategory).filter((c) => c !== 'code'),
  ];

  return (
    <div className="ml-4 mt-2 flex flex-col gap-2">
      {categoryOrder.map((cat) => {
        const catFiles = filesByCategory[cat];
        if (!catFiles || catFiles.length === 0) return null;
        const totalBytes = catFiles.reduce((s, f) => s + (f.bytes ?? 0), 0);
        const estTokens = catFiles.reduce((s, f) => s + (f.estTokens ?? 0), 0);
        const label =
          cat === 'code' ? 'Code' : cat.charAt(0).toUpperCase() + cat.slice(1);
        const borderColor =
          cat === 'code'
            ? 'border-l-blue-300 dark:border-l-blue-700'
            : 'border-l-violet-300 dark:border-l-violet-700';
        return (
          <div key={cat} className={`border-l-2 pl-2 ${borderColor}`}>
            <SectionHeader
              icon="▤"
              label={label}
              summary={buildFileSummary(catFiles.length, totalBytes, estTokens)}
              open={catOpen[cat] ?? false}
              onToggle={() =>
                setCatOpen((prev) => ({ ...prev, [cat]: !prev[cat] }))
              }
            />
            {(catOpen[cat] ?? false) && (
              <div className="pl-2">
                <table className="mt-1 w-full">
                  <tbody>
                    {catFiles.map((file, i) => (
                      <FileRow key={i} file={file} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
