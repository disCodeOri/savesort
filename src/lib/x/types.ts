export interface XOAuthToken {
  access_token: string;
  /** Issued only when offline.access was granted. */
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export interface XAccount {
  id: string;
  username: string;
  name: string | null;
  profileImageUrl: string | null;
}

export interface XMedia {
  mediaKey: string;
  type: string;
  previewImageUrl: string | null;
  altText: string | null;
}

export interface XPost {
  id: string;
  text: string;
  authorId: string | null;
  createdAt: string | null;
  lang: string | null;
  conversationId: string | null;
  /** Outbound links, already unwound from t.co where X expands them. */
  urls: string[];
  mediaKeys: string[];
  /** ids of quoted/replied-to posts, used to attach context for search. */
  referencedPostIds: string[];
}

export interface XBookmarkPage {
  posts: XPost[];
  /** Authors and referenced posts arrive as expansions in the same response. */
  authorsById: Map<string, XAccount>;
  mediaByKey: Map<string, XMedia>;
  referencedPostsById: Map<string, XPost>;
  nextToken: string | null;
  /** How many entries the response contained, including unusable ones. */
  resultCount: number;
}

export interface XRateLimit {
  limit: number | null;
  remaining: number | null;
  /** Epoch seconds from x-rate-limit-reset, when present. */
  resetAt: Date | null;
}
