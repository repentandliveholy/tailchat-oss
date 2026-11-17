//! One driver per store file: two cores on one file would each trust their
//! own memory (spec, stage 4).

use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::Path;

use crate::StartError;

/// The advisory lock on `<db_path>.lock`, held for as long as this lives. The
/// operating system drops it with the process, so a crash never leaves a stale
/// lock behind.
#[derive(Debug)]
pub(crate) struct InstanceLock {
    /// Locked for as long as the handle is open.
    _file: File,
}

impl InstanceLock {
    /// Takes the lock for the store at `db_path`, creating the parent
    /// directory and the lock file as needed.
    ///
    /// [`StartError::Locked`] when another driver (in this process or any
    /// other) holds it.
    pub(crate) fn acquire(db_path: &Path) -> Result<Self, StartError> {
        if let Some(parent) = db_path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }
        let mut name = db_path.as_os_str().to_owned();
        name.push(".lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&name)?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(TryLockError::WouldBlock) => Err(StartError::Locked),
            Err(TryLockError::Error(error)) => Err(StartError::Io(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_holder_is_refused_until_the_first_lets_go() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("alice.db");
        let first = InstanceLock::acquire(&path).unwrap();
        assert!(matches!(
            InstanceLock::acquire(&path),
            Err(StartError::Locked)
        ));
        // Another file is another store.
        InstanceLock::acquire(&dir.path().join("bob.db")).unwrap();
        drop(first);
        InstanceLock::acquire(&path).unwrap();
    }
}
