use std::path::{Path, PathBuf};

use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::EnvFilter;

/// Structured JSON logs, rotated daily, written to the app data directory.
///
/// Note contents are never passed to these macros anywhere in the codebase —
/// only file ids, relative paths, operation names, status codes, and error
/// categories. Tokens are likewise never logged; the auth client returns
/// errors without echoing credentials.
pub fn init(log_dir: &Path) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    if let Err(error) = std::fs::create_dir_all(log_dir) {
        eprintln!("could not create log directory: {error}");
        return None;
    }

    let file_appender = tracing_appender::rolling::daily(log_dir, "savesort-desktop.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let filter = EnvFilter::try_from_env("SAVESORT_LOG")
        .unwrap_or_else(|_| EnvFilter::new("savesort_desktop=info,savesort_core=info"));

    tracing_subscriber::fmt()
        .json()
        .with_env_filter(filter)
        .with_writer(non_blocking.and(std::io::stdout))
        .with_target(true)
        .init();

    Some(guard)
}

pub fn log_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("logs")
}
