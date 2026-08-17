use std::collections::HashMap;

/// Coalesces a burst of raw filesystem events per path into one logical
/// change, ready only once no new event has arrived for `window_ms`. This is
/// a pure timing primitive — driven by an explicit millisecond clock rather
/// than `std::time::Instant`, so tests can simulate bursts and elapsed time
/// deterministically instead of sleeping.
///
/// This alone does not prove a file is safe to read (an editor can still be
/// mid-write when the timer elapses); the watcher pairs `drain_ready` with a
/// size/mtime stability re-check before actually opening the file, and
/// re-arms the debounce if that check finds the file still changing.
#[derive(Debug, Default)]
pub struct Debouncer {
    window_ms: u64,
    pending: HashMap<String, u64>,
}

impl Debouncer {
    pub fn new(window_ms: u64) -> Self {
        Self {
            window_ms,
            pending: HashMap::new(),
        }
    }

    /// Records a raw event for a path. A repeated event for the same path
    /// resets its timer, so a burst of edits only becomes ready once the
    /// *last* one is old enough — the fix for "never assume one filesystem
    /// event equals one logical change."
    pub fn record_event(&mut self, relative_path: &str, at_ms: u64) {
        self.pending.insert(relative_path.to_string(), at_ms);
    }

    /// Paths whose most recent event is at least `window_ms` old, removed
    /// from the pending set as they are returned.
    pub fn drain_ready(&mut self, now_ms: u64) -> Vec<String> {
        let ready: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, &last)| now_ms.saturating_sub(last) >= self.window_ms)
            .map(|(path, _)| path.clone())
            .collect();
        for path in &ready {
            self.pending.remove(path);
        }
        ready
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_event_becomes_ready_once_its_window_elapses() {
        let mut debouncer = Debouncer::new(300);
        debouncer.record_event("Note.md", 1_000);

        assert!(debouncer.drain_ready(1_200).is_empty());
        assert_eq!(debouncer.drain_ready(1_300), vec!["Note.md"]);
    }

    #[test]
    fn a_burst_of_edits_resets_the_timer_to_the_last_one() {
        let mut debouncer = Debouncer::new(300);
        debouncer.record_event("Note.md", 1_000);
        debouncer.record_event("Note.md", 1_150);
        debouncer.record_event("Note.md", 1_250);

        // 300ms after the first event, but only 50ms after the last one.
        assert!(debouncer.drain_ready(1_300).is_empty());
        assert_eq!(debouncer.drain_ready(1_550), vec!["Note.md"]);
    }

    #[test]
    fn tracks_independent_paths_separately() {
        let mut debouncer = Debouncer::new(300);
        debouncer.record_event("A.md", 1_000);
        debouncer.record_event("B.md", 1_200);

        let ready = debouncer.drain_ready(1_300);
        assert_eq!(ready, vec!["A.md".to_string()]);
        assert!(debouncer.has_pending());

        assert_eq!(debouncer.drain_ready(1_500), vec!["B.md"]);
        assert!(!debouncer.has_pending());
    }

    #[test]
    fn a_drained_path_can_be_re_armed_by_a_later_edit() {
        let mut debouncer = Debouncer::new(300);
        debouncer.record_event("Note.md", 1_000);
        assert_eq!(debouncer.drain_ready(1_300), vec!["Note.md"]);

        debouncer.record_event("Note.md", 2_000);
        assert!(debouncer.drain_ready(2_100).is_empty());
        assert_eq!(debouncer.drain_ready(2_300), vec!["Note.md"]);
    }

    #[test]
    fn draining_with_nothing_pending_is_a_no_op() {
        let mut debouncer = Debouncer::new(300);
        assert!(debouncer.drain_ready(999_999).is_empty());
    }
}
