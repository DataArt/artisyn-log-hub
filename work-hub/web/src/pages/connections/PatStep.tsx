// The access-token part of a connection: a link to the provider's token page (`{web}` filled in)
// with the scope hint, the username when the provider needs one, the write-only token and the
// "Expose to agent as env var" switch (D9).

import type { ProviderInfo } from "../../api/connections";
import { Input } from "../../ui/input";
import styles from "./dialogs.module.css";
import { fillWeb } from "./format";

export interface PatValue {
  username: string;
  token: string;
  expose: boolean;
  envName: string;
}

export interface PatStepProps {
  provider: ProviderInfo;
  /** The connection base URL, for `{web}`. */
  web: string;
  value: PatValue;
  onChange: (v: PatValue) => void;
  /** Show the token field (the Edit dialog hides it until "Update token…"). */
  showToken?: boolean;
  /** Show the username field (the Edit dialog shows it only when updating the token). */
  showUsername?: boolean;
  tokenPlaceholder?: string;
  errors?: { token?: string | null; envName?: string | null };
}

/** The expose switch and its env name field; also used, disabled, for SSH in the Edit dialog. */
export function ExposeSwitch({
  expose,
  envName,
  disabled = false,
  error,
  onChange,
}: {
  expose: boolean;
  envName: string;
  disabled?: boolean;
  error?: string | null;
  onChange: (expose: boolean, envName: string) => void;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.choice} data-disabled={disabled}>
        <input
          type="checkbox"
          role="switch"
          checked={expose}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked, envName)}
          data-testid="connection-expose"
        />
        Expose to agent as env var
      </label>
      {expose && !disabled && (
        <>
          <Input
            aria-label="Environment variable name"
            placeholder="GIT_TOKEN"
            value={envName}
            aria-invalid={Boolean(error)}
            onChange={(e) => onChange(true, e.target.value)}
            data-testid="connection-expose-env"
          />
          <p className={styles.hint}>
            The agent and everything it runs in the workspace can read this
            token. Use it only when tools need the host's API.
          </p>
        </>
      )}
      {error && (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function PatStep({
  provider,
  web,
  value,
  onChange,
  showToken = true,
  showUsername = true,
  tokenPlaceholder,
  errors,
}: PatStepProps) {
  const tokenPage = fillWeb(provider.tokenPageUrl, web);
  return (
    <>
      {tokenPage && (
        <div className={styles.field}>
          <a
            className={styles.link}
            href={tokenPage}
            target="_blank"
            rel="noreferrer"
            data-testid="connection-token-page"
          >
            Create token ↗
          </a>
          {provider.tokenScopes && (
            <p className={styles.hint}>Scopes: {provider.tokenScopes}</p>
          )}
        </div>
      )}
      {showUsername && provider.needsUsername && (
        <div className={styles.field}>
          <label htmlFor="connection-username" className={styles.label}>
            Username
          </label>
          <Input
            id="connection-username"
            autoComplete="off"
            value={value.username}
            onChange={(e) => onChange({ ...value, username: e.target.value })}
            data-testid="connection-username"
          />
        </div>
      )}
      {showToken && (
        <div className={styles.field}>
          <label htmlFor="connection-token" className={styles.label}>
            Token
          </label>
          <Input
            id="connection-token"
            type="password"
            autoComplete="new-password"
            placeholder={tokenPlaceholder}
            value={value.token}
            aria-invalid={Boolean(errors?.token)}
            onChange={(e) => onChange({ ...value, token: e.target.value })}
            data-testid="connection-token"
          />
          {errors?.token && (
            <p className={styles.errorText} role="alert">
              {errors.token}
            </p>
          )}
        </div>
      )}
      <ExposeSwitch
        expose={value.expose}
        envName={value.envName}
        error={errors?.envName}
        onChange={(expose, envName) => onChange({ ...value, expose, envName })}
      />
    </>
  );
}
