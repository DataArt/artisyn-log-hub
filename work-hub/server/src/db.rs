//! Postgres pool and schema migrations (Database changes).
//!
//! Work Hub lives in its own schema (`WORK_HUB_DB_SCHEMA`). Every pooled connection gets that
//! schema as its `search_path`, so all queries — and sqlx's own `_sqlx_migrations` table — stay
//! inside it.

use std::time::Duration;

use sqlx::Executor;
use sqlx::postgres::{PgPool, PgPoolOptions};

use crate::config::{Config, is_valid_schema_name};

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("invalid schema name {0:?}")]
    InvalidSchema(String),
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

/// Connects, creates the schema when missing and runs the migrations.
pub async fn init(config: &Config) -> Result<PgPool, DbError> {
    let pool = connect(&config.database_url, &config.db_schema).await?;
    migrate(&pool, &config.db_schema).await?;
    Ok(pool)
}

/// A pool whose every connection uses `schema` as its `search_path`.
pub async fn connect(database_url: &str, schema: &str) -> Result<PgPool, DbError> {
    if !is_valid_schema_name(schema) {
        return Err(DbError::InvalidSchema(schema.to_string()));
    }
    let set_path = format!("SET search_path TO \"{schema}\"");
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(move |conn, _meta| {
            let sql = set_path.clone();
            Box::pin(async move {
                conn.execute(sql.as_str()).await?;
                Ok(())
            })
        })
        .connect(database_url)
        .await?;
    Ok(pool)
}

/// `CREATE SCHEMA IF NOT EXISTS` and the embedded migrations (sqlx takes its own advisory lock).
pub async fn migrate(pool: &PgPool, schema: &str) -> Result<(), DbError> {
    if !is_valid_schema_name(schema) {
        return Err(DbError::InvalidSchema(schema.to_string()));
    }
    pool.execute(format!("CREATE SCHEMA IF NOT EXISTS \"{schema}\"").as_str())
        .await?;
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}
