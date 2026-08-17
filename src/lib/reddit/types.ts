export interface RedditOAuthToken {
  access_token: string;
  /** Only returned by the authorization-code exchange when duration=permanent. */
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

export interface RedditIdentity {
  /** Reddit account ids are base36 strings such as "2fp8x", not numbers. */
  id: string;
  name: string;
  icon_img: string | null;
}

/** The `data` payload of a `t3` (link) child in a saved listing. */
export interface RedditSavedPost {
  id: string;
  name: string;
  permalink: string;
  title: string;
  subreddit: string;
  subreddit_name_prefixed: string;
  author: string;
  url: string | null;
  selftext: string | null;
  link_flair_text: string | null;
  thumbnail: string | null;
  score: number;
  num_comments: number;
  created_utc: number;
  over_18: boolean;
  is_self: boolean;
}

export interface RedditSavedPage {
  posts: RedditSavedPost[];
  /**
   * Every child Reddit returned for this page, including entries that were not
   * usable link posts, so sync progress reports what the account really holds.
   */
  discoveredCount: number;
  /** Reddit's `after` fullname, or null once the listing is exhausted. */
  nextCursor: string | null;
}
