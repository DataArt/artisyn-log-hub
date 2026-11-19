import * as nodemailer from 'nodemailer';

/** SMTP settings, already read from the environment by the caller. */
export interface SmtpTransportEnv {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
}

/**
 * The one place an SMTP transport is built — shared by `MailService` and the
 * strict-managed admin bootstrap, which runs in `initializeDatabase()` before
 * the Nest container exists. Auth is used only when both user and password
 * are set. Short timeouts make an unreachable relay fail fast instead of
 * hanging startup or a request.
 */
export function createSmtpTransport(
  env: SmtpTransportEnv,
): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: env.host,
    port: env.port,
    secure: env.secure,
    auth:
      env.user && env.password
        ? { user: env.user, pass: env.password }
        : undefined,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 5_000,
  });
}
