/**
 * Settings → Analysis "OKF thresholds" card (FR-17, impl-plan DD-19 / DD-22 of
 * 2026-11-03-okf-view-kb-value): a SETTING / DEFAULT / VALUE / WHAT IT AFFECTS table in two
 * groups (verdict, value signals), the `codeRoots` tag list and a "Not settings" footer of the
 * fixed limits. Saves write only the fields that differ from `okfDefaults` and never recompute.
 *
 * The verdict card's thresholds chip links here with `sfocus=okf-thresholds`; on mount the card
 * scrolls into view and drops that param. `id="okf-thresholds"` is only a DOM anchor (the app
 * uses a hash router, so a URL hash cannot address it).
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { cn } from '../../lib/cn';
import type { OkfThresholds } from '../../../models/repositories';
import type { RepoSettingsResponse } from '../../api';
import { OkfCodeRootsInput } from './OkfCodeRootsInput';
import { OKF_THRESHOLDS_FOCUS } from './okf/okf-url-state';
import {
  OKF_CODE_ROOTS_AFFECTS,
  OKF_VALUE_SIGNAL_FIELDS,
  OKF_VERDICT_FIELDS,
  isOkfFormValid,
  okfFormFromSection,
  okfNumericFieldError,
  okfSectionFromForm,
  sameOkfForm,
  type OkfFieldDef,
  type OkfThresholdsFormState,
} from './okf-thresholds-form';

export interface OkfThresholdsSectionProps {
  data: RepoSettingsResponse;
  isTeamView: boolean;
  readOnly: boolean;
  isSaving: boolean;
  /**
   * Saves the scope's config with only `okf` replaced (read-modify-write in
   * `RepositorySettings`); `undefined` drops the section. Rejects with the server's message.
   */
  save: (okf: OkfThresholds | undefined) => Promise<unknown>;
}

/** The `okf` section in force for this view (DD-20): team row, or personal row → team row. */
export function okfSectionForView(
  data: RepoSettingsResponse,
  isTeamView: boolean,
): OkfThresholds | undefined {
  return isTeamView
    ? data.teamConfig?.okf
    : (data.userConfig?.okf ?? data.teamConfig?.okf);
}

export function OkfThresholdsSection({
  data,
  isTeamView,
  readOnly,
  isSaving,
  save,
}: OkfThresholdsSectionProps) {
  const defaults = data.okfDefaults;
  const [initial] = useState(() =>
    okfFormFromSection(defaults, okfSectionForView(data, isTeamView)),
  );
  const [form, setForm] = useState<OkfThresholdsFormState>(initial);
  const [saveError, setSaveError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const focused = searchParams.get('sfocus') === OKF_THRESHOLDS_FOCUS;
  useEffect(() => {
    if (!focused) return;
    rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('sfocus');
        return next;
      },
      { replace: true },
    );
  }, [focused, setSearchParams]);

  const valid = isOkfFormValid(form);
  const changed = !sameOkfForm(form, initial);
  const teamOkf = data.teamConfig?.okf;
  // Reset drops this scope's own section only; a personal view inheriting the team's keeps it.
  const hasStoredSection =
    (isTeamView ? data.teamConfig?.okf : data.userConfig?.okf) !== undefined;

  function setNumber(field: OkfFieldDef['field'], text: string) {
    setForm((f) => ({ ...f, numbers: { ...f.numbers, [field]: text } }));
    setSaveError(null);
  }

  async function run(okf: OkfThresholds | undefined) {
    setSaveError(null);
    try {
      await save(okf);
    } catch (err) {
      setSaveError(
        err instanceof Error && err.message !== ''
          ? err.message
          : 'Saving the OKF thresholds failed.',
      );
    }
  }

  function renderGroup(title: string, defs: readonly OkfFieldDef[]) {
    return (
      <>
        <tr>
          <th
            colSpan={4}
            className="pt-3 pb-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {title}
          </th>
        </tr>
        {defs.map(({ field, affects }) => {
          const error = okfNumericFieldError(field, form.numbers[field]);
          return (
            <tr
              key={field}
              data-testid={`okf-threshold-${field}`}
              className="border-t border-border align-top"
            >
              <td className="py-1.5 pr-3 font-mono text-xs">{field}</td>
              <td className="py-1.5 pr-3 text-right font-mono text-xs text-muted-foreground">
                {defaults[field]}
              </td>
              <td className="py-1 pr-3">
                <Input
                  value={form.numbers[field]}
                  readOnly={readOnly}
                  inputMode="decimal"
                  aria-label={field}
                  aria-invalid={error !== null}
                  onChange={(e) => setNumber(field, e.target.value)}
                  className={cn(
                    'h-7 w-28 text-right font-mono text-xs',
                    error !== null && 'border-destructive',
                  )}
                />
                {error !== null && (
                  <p className="mt-0.5 text-[11px] text-destructive">{error}</p>
                )}
              </td>
              <td className="py-1.5 text-xs text-muted-foreground">
                {affects}
              </td>
            </tr>
          );
        })}
      </>
    );
  }

  const limits = data.okfFixedLimits;

  return (
    <div
      id="okf-thresholds"
      ref={rootRef}
      data-testid="okf-thresholds-setting"
      className="flex flex-col gap-3 scroll-mt-4"
    >
      <div>
        <h3 className="text-sm font-medium">OKF thresholds</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Levels used by the OKF tab&apos;s verdict and value signals. They
          apply when the OKF tab is read, so saving needs no recompute.
        </p>
      </div>
      {readOnly && (
        <p className="text-xs font-medium text-muted-foreground">
          Managed by team owner
        </p>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="pr-3 font-medium">Setting</th>
            <th className="pr-3 text-right font-medium">Default</th>
            <th className="pr-3 font-medium">Value</th>
            <th className="font-medium">What it affects</th>
          </tr>
        </thead>
        <tbody>
          {renderGroup('Verdict', OKF_VERDICT_FIELDS)}
          {renderGroup('Value signals', OKF_VALUE_SIGNAL_FIELDS)}
          <tr
            data-testid="okf-threshold-codeRoots"
            className="border-t border-border align-top"
          >
            <td className="py-1.5 pr-3 font-mono text-xs">codeRoots</td>
            <td className="py-1.5 pr-3 text-right font-mono text-[11px] text-muted-foreground">
              {(defaults.codeRoots ?? []).join(' ')}
            </td>
            <td className="py-1 pr-3">
              <OkfCodeRootsInput
                roots={form.codeRoots}
                readOnly={readOnly}
                onChange={(codeRoots) => {
                  setForm((f) => ({ ...f, codeRoots }));
                  setSaveError(null);
                }}
              />
            </td>
            <td className="py-1.5 text-xs text-muted-foreground">
              {OKF_CODE_ROOTS_AFFECTS}
            </td>
          </tr>
        </tbody>
      </table>

      <p
        data-testid="okf-thresholds-fixed"
        className="text-xs text-muted-foreground"
      >
        <span className="font-medium">Not settings:</span> read top list{' '}
        {limits.readTopN} · hot files list {limits.hotFilesTopN} · task head{' '}
        {limits.taskHeadMaxChars} characters · search pattern cut to{' '}
        {limits.patternMaxChars} characters · at most{' '}
        {limits.eventCapPerNode.toLocaleString()} code events per agent.
      </p>

      {!readOnly && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!valid || !changed || isSaving}
              onClick={() => void run(okfSectionFromForm(defaults, form))}
            >
              {isSaving && <Loader2 className="size-3.5 animate-spin" />}
              Save for this repo
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!hasStoredSection || isSaving}
              onClick={() => void run(undefined)}
            >
              Reset to defaults
            </Button>
            {!isTeamView && teamOkf !== undefined && (
              <Button
                size="sm"
                variant="outline"
                disabled={isSaving}
                onClick={() => {
                  setForm(okfFormFromSection(defaults, teamOkf));
                  setSaveError(null);
                }}
              >
                Copy from team settings
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Saving writes only the fields that differ from the default.
          </p>
        </>
      )}
      {saveError !== null && (
        <p
          data-testid="okf-thresholds-error"
          className="text-xs text-destructive"
        >
          {saveError}
        </p>
      )}
    </div>
  );
}
