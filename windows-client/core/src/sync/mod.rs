mod api;
mod protocol;
mod reconcile;
mod worker;

pub use api::{ReqwestSyncApi, SyncApi, SyncApiError};
pub use protocol::{
    ChangeEntry, ChangesPage, DeleteFileEntry, MoveFileEntry, NoteResult, NoteResultStatus,
    RegisterVaultRequest, SyncFileUpload, VaultSummary,
};
pub use reconcile::{plan_from_scan, ReconcileAction};
pub use worker::{process_next, ProcessedOutcome, WorkerError};
