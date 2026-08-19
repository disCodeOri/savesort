import { strToU8, zipSync } from "fflate";

/**
 * Synthetic export fixtures.
 *
 * Every value here is invented. No real Reddit or LinkedIn account data is
 * committed to this repository, and none is needed: the parsers are driven by
 * column shape, so a fixture that has the right shape exercises the same code
 * paths a real export would.
 */

export function buildZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, contents] of Object.entries(files)) {
    entries[path] = strToU8(contents);
  }
  return zipSync(entries);
}

export function csv(headers: string[], rows: string[][]): string {
  const escape = (value: string) =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}

export const REDDIT_POST_PERMALINK =
  "https://www.reddit.com/r/localfirst/comments/abc123/why_crdts_beat_operational_transforms/";
export const REDDIT_COMMENT_PERMALINK =
  "https://www.reddit.com/r/localfirst/comments/abc123/why_crdts_beat_operational_transforms/def456/";

export const LONG_BODY =
  "Operational transforms need a central server to order edits, which is exactly the dependency a local-first application is trying to remove. CRDTs converge without coordination, so two offline replicas can merge later without a referee.";

/** `saved_posts.csv` really is just an id and a permalink. */
export function redditSavedPosts(): string {
  return csv(["id", "permalink"], [["abc123", REDDIT_POST_PERMALINK]]);
}

export function redditSavedComments(): string {
  return csv(["id", "permalink"], [["def456", REDDIT_COMMENT_PERMALINK]]);
}

export function redditOwnPosts(): string {
  return csv(
    [
      "id",
      "permalink",
      "date",
      "ip",
      "subreddit",
      "gildings",
      "title",
      "url",
      "body",
    ],
    [
      [
        "abc123",
        REDDIT_POST_PERMALINK,
        "2025-03-04 11:22:33 UTC",
        "203.0.113.4",
        "localfirst",
        "0",
        "Why CRDTs beat operational transforms",
        REDDIT_POST_PERMALINK,
        LONG_BODY,
      ],
    ],
  );
}

export function redditOwnComments(): string {
  return csv(
    [
      "id",
      "permalink",
      "date",
      "ip",
      "subreddit",
      "gildings",
      "link",
      "parent",
      "body",
    ],
    [
      [
        "def456",
        REDDIT_COMMENT_PERMALINK,
        "2025-03-05 08:00:00 UTC",
        "203.0.113.4",
        "localfirst",
        "0",
        REDDIT_POST_PERMALINK,
        "t3_abc123",
        "Worth adding that Automerge documents compact badly once history is long.",
      ],
    ],
  );
}

export function redditPostVotes(): string {
  return csv(
    ["id", "permalink", "direction"],
    [
      ["abc123", REDDIT_POST_PERMALINK, "up"],
      [
        "zzz999",
        "https://www.reddit.com/r/other/comments/zzz999/some_thing/",
        "down",
      ],
    ],
  );
}

/** Files the importer must never open. Contents are deliberately obvious. */
export function redditPrivateFiles(): Record<string, string> {
  return {
    "messages.csv": csv(["id", "body"], [["1", "PRIVATE MESSAGE BODY"]]),
    "chat_history.csv": csv(["id", "message"], [["1", "PRIVATE CHAT"]]),
    "ip_logs.csv": csv(["date", "ip"], [["2025-01-01", "203.0.113.9"]]),
    "linked_identities.csv": csv(["provider", "id"], [["google", "PRIVATE"]]),
  };
}

export function redditArchive(extra: Record<string, string> = {}): Uint8Array {
  return buildZip({
    "saved_posts.csv": redditSavedPosts(),
    "saved_comments.csv": redditSavedComments(),
    "post_votes.csv": redditPostVotes(),
    "subscribed_subreddits.csv": csv(["subreddit"], [["localfirst"]]),
    "statistics.csv": csv(["statistic", "value"], [["account_age", "5"]]),
    ...redditPrivateFiles(),
    ...extra,
  });
}

export const LINKEDIN_ACTIVITY_URL =
  "https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/";
/** The same activity, written the way `Reactions.csv` writes it. */
export const LINKEDIN_POSTS_URL =
  "https://www.linkedin.com/posts/jane-doe-1234_local-first-databases-activity-7100000000000000001-Ab1c";

export const LINKEDIN_SHARE_TEXT =
  "Spent the weekend replacing our sync layer with a CRDT. The migration was smaller than expected and offline editing finally works on flaky hotel wifi.";

export function linkedInSavedItems(): string {
  return csv(
    ["Saved Date", "savedItem"],
    [["2025-05-12 09:31:04 UTC", LINKEDIN_ACTIVITY_URL]],
  );
}

export function linkedInReactions(): string {
  return csv(
    ["Date", "Type", "Link"],
    [["2025-05-11 18:02:00 UTC", "LIKE", LINKEDIN_POSTS_URL]],
  );
}

export function linkedInShares(): string {
  return csv(
    [
      "Date",
      "ShareLink",
      "ShareCommentary",
      "SharedUrl",
      "MediaUrl",
      "Visibility",
    ],
    [
      [
        "2025-05-10 12:00:00 UTC",
        LINKEDIN_POSTS_URL,
        LINKEDIN_SHARE_TEXT,
        "https://example.com/crdt-writeup",
        "",
        "MEMBER_NETWORK",
      ],
    ],
  );
}

export function linkedInComments(): string {
  return csv(
    ["Date", "Link", "Message"],
    [
      [
        "2025-05-12 10:00:00 UTC",
        LINKEDIN_POSTS_URL,
        "This matches what we saw migrating our own editor to Automerge.",
      ],
    ],
  );
}

export function linkedInSavedJobs(): string {
  return csv(
    ["Job Title", "Company Name", "Job Url", "Saved Date"],
    [
      [
        "Staff Engineer, Sync",
        "Northwind Software",
        "https://www.linkedin.com/jobs/view/3900000001/",
        "2025-04-02 08:00:00 UTC",
      ],
    ],
  );
}

export function linkedInPrivateFiles(): Record<string, string> {
  return {
    "Connections.csv": csv(
      ["First Name", "Last Name", "Email Address"],
      [["Private", "Person", "private@example.com"]],
    ),
    "messages.csv": csv(["FROM", "CONTENT"], [["someone", "PRIVATE MESSAGE"]]),
    "Ad_Targeting.csv": csv(["Category", "Value"], [["interest", "PRIVATE"]]),
    "Logins.csv": csv(["Date", "IP Address"], [["2025-01-01", "203.0.113.9"]]),
    "Profile.csv": csv(
      ["First Name", "Address"],
      [["Jane", "PRIVATE ADDRESS"]],
    ),
  };
}

export function linkedInArchive(
  extra: Record<string, string> = {},
): Uint8Array {
  return buildZip({
    "Saved_Items.csv": linkedInSavedItems(),
    "Saved_Jobs.csv": linkedInSavedJobs(),
    "Reactions.csv": linkedInReactions(),
    "Rich_Media.csv": csv(["Media Link"], [["https://example.com/a.png"]]),
    "Invitations.csv": csv(["From", "To"], [["a", "b"]]),
    ...linkedInPrivateFiles(),
    ...extra,
  });
}
