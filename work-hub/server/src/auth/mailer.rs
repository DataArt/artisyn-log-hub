//! Outbound e-mail (D3): lettre SMTP from `SMTP_*`, a port of Log Hub's `mail/mail.service.ts`.
//!
//! A transport exists only when SMTP applies to the active mode (`password`, `password-confirm`)
//! and `SMTP_HOST` is set; otherwise nothing ever touches the network. At startup the relay is
//! checked once: in `password-confirm` (outside `WORK_HUB_ENV=test`) an unreachable relay aborts
//! startup, elsewhere it is a warning.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use lettre::message::Mailbox;
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Serialize;

use crate::auth::{AuthMode, js};
use crate::config::{Config, RunEnv};

/// Connect, greeting and socket timeout: fail fast when the relay is unreachable.
const SMTP_TIMEOUT: Duration = Duration::from_secs(5);

/// Fallback link base outside production when `PUBLIC_BASE_URL` is unset (the Vite dev client).
pub const DEV_PUBLIC_BASE_URL: &str = "http://localhost:5180";

/// The outcome of one e-mail, as the API reports it (`email_delivery`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EmailDelivery {
    Sent,
    Failed,
    /// SMTP is not configured for this mode (change-password's notice only).
    Skipped,
}

pub struct Mailer {
    transport: Option<AsyncSmtpTransport<Tokio1Executor>>,
    from: Option<Mailbox>,
    /// `SMTP_HOST:SMTP_PORT`, for messages.
    relay: String,
    mode: AuthMode,
    env: RunEnv,
    public_base_url: Option<String>,
    missing_base_warned: AtomicBool,
}

/// Masks an e-mail for log lines: `dune@arrakis.test` → `d***@arrakis.test` (Log Hub's
/// `maskEmail`).
pub fn mask_email(email: &str) -> String {
    let value = js::trim(email);
    let Some(at) = value.rfind('@') else {
        return "***".into();
    };
    let head = value[..at]
        .chars()
        .next()
        .map(String::from)
        .unwrap_or_default();
    format!("{head}***@{}", &value[at + 1..])
}

impl Mailer {
    /// Builds the transport from the config. Never connects.
    pub fn from_config(config: &Config) -> Result<Self, String> {
        let env = &config.auth_env;
        let mode = config.auth.mode;
        let host = env.get("SMTP_HOST").map(js::trim).unwrap_or("").to_string();
        let port_raw = env.get("SMTP_PORT").map(js::trim).unwrap_or("").to_string();
        let relay = format!("{host}:{port_raw}");
        let configured =
            matches!(mode, AuthMode::Password | AuthMode::PasswordConfirm) && !host.is_empty();
        let mut mailer = Mailer {
            transport: None,
            from: None,
            relay,
            mode,
            env: config.env,
            public_base_url: config.auth.public_base_url.clone(),
            missing_base_warned: AtomicBool::new(false),
        };
        if !configured {
            return Ok(mailer);
        }
        let port: u16 = port_raw
            .parse()
            .map_err(|_| format!("SMTP_PORT must be a port number, got: {port_raw}"))?;
        let secure = env.get("SMTP_SECURE") == Some("true");
        let builder = if secure {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
                .map_err(|e| format!("cannot set up SMTP for {host}: {e}"))?
        } else {
            // nodemailer's `secure: false`: plain connection, STARTTLS when the relay offers it.
            let tls = TlsParameters::new(host.clone())
                .map_err(|e| format!("cannot set up SMTP TLS for {host}: {e}"))?;
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host)
                .tls(Tls::Opportunistic(tls))
        };
        let mut builder = builder.port(port).timeout(Some(SMTP_TIMEOUT));
        let user = env.get("SMTP_USER").unwrap_or("");
        let password = env.get("SMTP_PASSWORD").unwrap_or("");
        if !user.is_empty() && !password.is_empty() {
            builder = builder.credentials(Credentials::new(user.to_string(), password.to_string()));
        }
        mailer.transport = Some(builder.build());
        mailer.from = match env.get("SMTP_FROM").map(js::trim) {
            Some(f) if !f.is_empty() => Some(
                f.parse::<Mailbox>()
                    .map_err(|e| format!("SMTP_FROM is not a valid address ({f}): {e}"))?,
            ),
            _ => None,
        };
        Ok(mailer)
    }

    /// Outbound mail is set up for the active mode (the gate of every send path).
    pub fn is_configured(&self) -> bool {
        self.transport.is_some()
    }

    /// The startup reachability check. `Err` only in `password-confirm` outside `test`.
    pub async fn verify_at_startup(&self) -> Result<(), String> {
        let Some(transport) = &self.transport else {
            return Ok(());
        };
        let err = match transport.test_connection().await {
            Ok(true) => return Ok(()),
            Ok(false) => "the relay did not answer".to_string(),
            Err(e) => e.to_string(),
        };
        if self.mode == AuthMode::PasswordConfirm && self.env != RunEnv::Test {
            return Err(format!(
                "SMTP relay {} is unreachable; AUTH_MODE=password-confirm requires a working relay: {err}",
                self.relay
            ));
        }
        tracing::warn!("SMTP connection check failed (will retry on the first send): {err}");
        Ok(())
    }

    /// The base of e-mailed links: `PUBLIC_BASE_URL`, else the dev client outside production,
    /// else `None` (the e-mail is skipped; warned once per process). Never the request's `Host`.
    pub fn link_base_url(&self) -> Option<String> {
        if let Some(base) = &self.public_base_url {
            return Some(base.clone());
        }
        if self.env != RunEnv::Production {
            return Some(DEV_PUBLIC_BASE_URL.to_string());
        }
        if !self.missing_base_warned.swap(true, Ordering::Relaxed) {
            tracing::warn!("mail: PUBLIC_BASE_URL not set, email link not sent");
        }
        None
    }

    /// `<base>/#/confirm-email?token=…`, `None` without a base URL.
    pub fn confirm_url(&self, token: &str) -> Option<String> {
        self.link_base_url()
            .map(|b| format!("{b}/#/confirm-email?token={token}"))
    }

    /// `<base>/#/reset-password?token=…`, `None` without a base URL.
    pub fn reset_url(&self, token: &str) -> Option<String> {
        self.link_base_url()
            .map(|b| format!("{b}/#/reset-password?token={token}"))
    }

    pub async fn send_confirmation_email(&self, to: &str, url: &str) -> EmailDelivery {
        self.send(
            to,
            "Confirm your email address",
            format!(
                "Confirm your email address to finish creating your account (valid for 24 hours):\n\n{url}\n\nIf you did not request this, you can ignore this email."
            ),
        )
        .await
    }

    pub async fn send_password_reset_email(&self, to: &str, url: &str) -> EmailDelivery {
        self.send(
            to,
            "Reset your password",
            format!(
                "You requested a password reset. Use the link below to set a new password (valid for 1 hour):\n\n{url}\n\nIf you did not request this, you can ignore this email."
            ),
        )
        .await
    }

    pub async fn send_password_changed_email(&self, to: &str) -> EmailDelivery {
        self.send(
            to,
            "Your password was changed",
            format!(
                "The password for your account ({to}) was just changed. All other signed-in sessions have been signed out.\n\nIf you did not do this, reset your password immediately and contact your administrator."
            ),
        )
        .await
    }

    async fn send(&self, to: &str, subject: &str, text: String) -> EmailDelivery {
        let (Some(transport), Some(from)) = (&self.transport, &self.from) else {
            return EmailDelivery::Failed;
        };
        let to_box = match to.parse::<Mailbox>() {
            Ok(m) => m,
            Err(e) => {
                tracing::error!("cannot email {}: bad address: {e}", mask_email(to));
                return EmailDelivery::Failed;
            }
        };
        let message = Message::builder()
            .from(from.clone())
            .to(to_box)
            .subject(subject)
            .header(ContentType::TEXT_PLAIN)
            .body(text);
        let message = match message {
            Ok(m) => m,
            Err(e) => {
                tracing::error!("cannot build email to {}: {e}", mask_email(to));
                return EmailDelivery::Failed;
            }
        };
        match transport.send(message).await {
            Ok(_) => EmailDelivery::Sent,
            Err(e) => {
                tracing::error!("failed to send email to {}: {e}", mask_email(to));
                EmailDelivery::Failed
            }
        }
    }
}
