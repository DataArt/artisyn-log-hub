// Step 1 of "Add connection": provider tiles (from `GET /connection-providers`), the base URL when
// the provider has no fixed one, the name and the auth method. "Generate a key in Work Hub" is
// preselected whenever the provider allows it. A provider with a hosted instance and no fixed URL
// (`baseUrlHosted`) offers "<hosted host> / Self-managed"; only "Self-managed" shows the URL field.

import { useState } from "react";
import type { AuthMethod, ProviderInfo } from "../../api/connections";
import { Input } from "../../ui/input";
import styles from "./dialogs.module.css";
import { AUTH_LABEL, AUTH_ORDER } from "./format";

export interface ProviderChoice {
  providerId: string | null;
  baseUrl: string;
  name: string;
  authMethod: AuthMethod | null;
}

export interface ProviderStepProps {
  providers: ProviderInfo[];
  value: ProviderChoice;
  onChange: (v: ProviderChoice) => void;
  errors: { baseUrl?: string | null; name?: string | null };
}

/** The auth method a provider starts with: the generated key when allowed, else its first. */
export function defaultAuth(p: ProviderInfo): AuthMethod | null {
  if (p.authMethods.includes("ssh_generated")) return "ssh_generated";
  return AUTH_ORDER.find((m) => p.authMethods.includes(m)) ?? null;
}

/** The host part of a URL for the hosted-instance label; the URL itself when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ProviderStep({
  providers,
  value,
  onChange,
  errors,
}: ProviderStepProps) {
  const selected = providers.find((p) => p.id === value.providerId);
  const [selfManaged, setSelfManaged] = useState(false);
  const hosted =
    selected && !selected.baseUrlFixed ? selected.baseUrlHosted : null;
  const showUrl = Boolean(
    selected && !selected.baseUrlFixed && (!hosted || selfManaged),
  );

  const pick = (p: ProviderInfo) => {
    if (p.id === value.providerId) return;
    setSelfManaged(false);
    onChange({
      ...value,
      providerId: p.id,
      baseUrl: !p.baseUrlFixed && p.baseUrlHosted ? p.baseUrlHosted : "",
      authMethod: defaultAuth(p),
    });
  };

  const pickHosting = (self: boolean) => {
    if (!hosted || self === selfManaged) return;
    setSelfManaged(self);
    onChange({ ...value, baseUrl: self ? "" : hosted });
  };

  return (
    <>
      <div className={styles.field}>
        <span className={styles.label}>Provider</span>
        <div className={styles.tiles} role="radiogroup" aria-label="Provider">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={p.id === value.providerId}
              className={styles.tile}
              data-selected={p.id === value.providerId}
              onClick={() => pick(p)}
              data-testid="connection-provider"
              data-provider-id={p.id}
            >
              <span className={styles.tileLabel}>{p.shortLabel}</span>
              {p.displayName}
            </button>
          ))}
        </div>
      </div>

      {hosted && (
        <div className={styles.field} role="radiogroup" aria-label="Server">
          <span className={styles.label}>Server</span>
          <label className={styles.choice}>
            <input
              type="radio"
              name="connection-hosting"
              checked={!selfManaged}
              onChange={() => pickHosting(false)}
              data-testid="connection-base-hosted"
            />
            <span>{hostOf(hosted)}</span>
          </label>
          <label className={styles.choice}>
            <input
              type="radio"
              name="connection-hosting"
              checked={selfManaged}
              onChange={() => pickHosting(true)}
              data-testid="connection-base-self-managed"
            />
            <span>Self-managed</span>
          </label>
        </div>
      )}

      {selected && showUrl && (
        <div className={styles.field}>
          <label htmlFor="connection-base-url" className={styles.label}>
            Server URL
          </label>
          <Input
            id="connection-base-url"
            value={value.baseUrl}
            placeholder={selected.baseUrlPlaceholder}
            aria-invalid={Boolean(errors.baseUrl)}
            onChange={(e) => onChange({ ...value, baseUrl: e.target.value })}
            data-testid="connection-base-url"
          />
          {errors.baseUrl && (
            <p className={styles.errorText} role="alert">
              {errors.baseUrl}
            </p>
          )}
        </div>
      )}

      {selected && (
        <>
          <div className={styles.field}>
            <label htmlFor="connection-name" className={styles.label}>
              Name
            </label>
            <Input
              id="connection-name"
              value={value.name}
              placeholder={`My ${selected.displayName}`}
              aria-invalid={Boolean(errors.name)}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              data-testid="connection-name"
            />
            {errors.name && (
              <p className={styles.errorText} role="alert">
                {errors.name}
              </p>
            )}
          </div>
          <div className={styles.field} role="radiogroup" aria-label="Auth">
            <span className={styles.label}>Authentication</span>
            {AUTH_ORDER.filter((m) => selected.authMethods.includes(m)).map(
              (m) => (
                <label key={m} className={styles.choice}>
                  <input
                    type="radio"
                    name="connection-auth"
                    value={m}
                    checked={value.authMethod === m}
                    onChange={() => onChange({ ...value, authMethod: m })}
                    data-testid={`connection-auth-${m}`}
                  />
                  <span>
                    {AUTH_LABEL[m]}
                    {m === "ssh_generated" && (
                      <span className={styles.star}> ★ Recommended</span>
                    )}
                  </span>
                </label>
              ),
            )}
          </div>
        </>
      )}
    </>
  );
}
