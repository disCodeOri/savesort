/// Retry delays for a failed sync operation: 5s, 15s, 30s, 1m, 2m, then a
/// steady 5m plateau. `attempt` is 1 for the first failure.
const SCHEDULE_SECONDS: [u64; 6] = [5, 15, 30, 60, 120, 300];

/// The delay before retrying the `attempt`-th failure. Plateaus at the last
/// schedule entry rather than growing unbounded, so a note stuck failing
/// during a long outage still gets retried every five minutes instead of
/// drifting toward once a day.
pub fn delay_seconds(attempt: u32) -> u64 {
    let index = attempt.saturating_sub(1) as usize;
    SCHEDULE_SECONDS
        .get(index)
        .copied()
        .unwrap_or(*SCHEDULE_SECONDS.last().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_the_documented_schedule() {
        assert_eq!(delay_seconds(1), 5);
        assert_eq!(delay_seconds(2), 15);
        assert_eq!(delay_seconds(3), 30);
        assert_eq!(delay_seconds(4), 60);
        assert_eq!(delay_seconds(5), 120);
        assert_eq!(delay_seconds(6), 300);
    }

    #[test]
    fn plateaus_instead_of_growing_unbounded() {
        assert_eq!(delay_seconds(7), 300);
        assert_eq!(delay_seconds(100), 300);
    }

    #[test]
    fn attempt_zero_behaves_like_attempt_one() {
        // A defensive floor: attempts are 1-indexed by convention, but a
        // caller passing 0 should not underflow or panic.
        assert_eq!(delay_seconds(0), 5);
    }
}
