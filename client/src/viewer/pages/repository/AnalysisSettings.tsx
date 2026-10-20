import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { cn } from '../../lib/cn';
import {
  CACHE_CREATION_THRESHOLD_MAX,
  CACHE_CREATION_THRESHOLD_MIN,
  DEFAULT_HIGH_CACHE_CREATION_THRESHOLD,
} from '../../lib/cache-ratio-ui';

// ---------------------------------------------------------------------------
// CacheCreationThresholdSetting — Analysis tab body
// Extracted from RepositorySettings.tsx (component-size split).
// ---------------------------------------------------------------------------

interface CacheCreationThresholdSettingProps {
  /** Resolved value in force for this scope (user -> team -> built-in default). */
  initialValue: number;
  readOnly: boolean;
  isSaving: boolean;
  onSave(value: number): void;
}

export function CacheCreationThresholdSetting({
  initialValue,
  readOnly,
  isSaving,
  onSave,
}: CacheCreationThresholdSettingProps) {
  const [text, setText] = useState(String(initialValue));

  const trimmed = text.trim();
  const parsed = Number(trimmed);
  const isValid =
    trimmed !== '' &&
    Number.isInteger(parsed) &&
    parsed >= CACHE_CREATION_THRESHOLD_MIN &&
    parsed <= CACHE_CREATION_THRESHOLD_MAX;
  const canSave = !readOnly && isValid && parsed !== initialValue && !isSaving;

  return (
    <div
      data-testid="cache-creation-threshold-setting"
      className="flex flex-col gap-4"
    >
      {readOnly && (
        <p className="text-xs font-medium text-muted-foreground">
          Managed by team owner
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="high-cache-creation-threshold"
          className="text-sm font-medium"
        >
          High cache-creation threshold (tokens per turn)
        </label>
        <Input
          id="high-cache-creation-threshold"
          type="number"
          inputMode="numeric"
          min={CACHE_CREATION_THRESHOLD_MIN}
          max={CACHE_CREATION_THRESHOLD_MAX}
          step={1000}
          value={text}
          readOnly={readOnly}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={!isValid}
          className={cn('h-8 w-48 text-sm', !isValid && 'border-destructive')}
        />
        {!isValid && (
          <p className="text-xs text-destructive">
            Enter a whole number between{' '}
            {CACHE_CREATION_THRESHOLD_MIN.toLocaleString()} and{' '}
            {CACHE_CREATION_THRESHOLD_MAX.toLocaleString()}.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Turns that create at least this many cache tokens are attributed to a
          cause (compaction or file re-read) in the Cache read ratio report;
          everything below it is left unattributed. Saving recomputes this
          repository&apos;s cause figures for the current scope, which can take
          a moment on large repositories. Default is{' '}
          {DEFAULT_HIGH_CACHE_CREATION_THRESHOLD.toLocaleString()}.
        </p>
      </div>

      {!readOnly && (
        <div className="flex">
          <Button size="sm" disabled={!canSave} onClick={() => onSave(parsed)}>
            {isSaving && <Loader2 className="size-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TurnEndCostAdvisorSetting — Analysis tab body
// Extracted from RepositorySettings.tsx (component-size split).
// ---------------------------------------------------------------------------

interface TurnEndCostAdvisorSettingProps {
  /** Resolved value in force for this scope (user -> team -> built-in default). */
  initialValue: { enabled: boolean };
  readOnly: boolean;
  isSaving: boolean;
  onSave(value: { enabled: boolean }): void;
}

export function TurnEndCostAdvisorSetting({
  initialValue,
  readOnly,
  isSaving,
  onSave,
}: TurnEndCostAdvisorSettingProps) {
  const [enabled, setEnabled] = useState(initialValue.enabled);

  const canSave = !readOnly && enabled !== initialValue.enabled && !isSaving;

  return (
    <div
      data-testid="turn-end-cost-advisor-setting"
      className="flex flex-col gap-4"
    >
      {readOnly && (
        <p className="text-xs font-medium text-muted-foreground">
          Managed by team owner
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={enabled}
            disabled={readOnly}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer disabled:cursor-not-allowed"
          />
          <span className="text-sm font-medium">Turn-End Cost Advisor</span>
        </label>
        <p className="ml-5 text-xs text-muted-foreground">
          After each turn, ask the model for a one-line cost-saving suggestion.
          Runs on every enabled session regardless of cost.
        </p>
      </div>

      {!readOnly && (
        <div className="flex">
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() => onSave({ enabled })}
          >
            {isSaving && <Loader2 className="size-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
