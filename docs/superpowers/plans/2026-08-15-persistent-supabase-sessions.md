# Persistent Supabase Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a valid SaveSort login persistent across protected navigation, access-token refreshes, browser refreshes, and local server restarts.

**Architecture:** Retain `@supabase/ssr` cookie storage and repair only the Next.js proxy refresh boundary. The proxy immediately verifies claims, mirrors refreshed cookies onto both the forwarded request and outgoing response, and preserves every response header emitted by Supabase.

**Tech Stack:** Next.js 16 App Router proxy, TypeScript 6, `@supabase/ssr` 0.12.4, Supabase Auth, Vitest 4.

## Global Constraints

- Keep Supabase sessions in cookies; do not add local-storage or application-managed browser tokens.
- Use async Next.js request APIs.
- Do not expose a Supabase secret or service-role credential to the browser.
- Protected layouts and Route Handlers continue to authorize verified users close to data access.
- Return friendly authentication failures rather than stack traces.
- Preserve the user's unrelated `next-env.d.ts` and `UI-design-inspirations.md` changes.

---

### Task 1: Lock the session refresh contract with a regression test

**Files:**

- Create: `tests/supabase-proxy.test.ts`
- Modify: `src/lib/supabase/proxy.ts`

**Interfaces:**

- Consumes: `getSupabasePublicConfig(): { url: string; publishableKey: string }`
- Produces: `updateSession(request: NextRequest): Promise<NextResponse>` that calls `auth.getClaims()` and forwards cookies plus Supabase response headers.

- [ ] **Step 1: Write a failing proxy regression test**

Create `tests/supabase-proxy.test.ts` with a hoisted `createServerClient` mock. Have the mocked `getClaims()` call the configured cookie adapter with one persistent cookie and one Supabase response header:

```ts
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerClientMock } = vi.hoisted(() => ({
  createServerClientMock: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
}));

vi.mock("@/lib/env", () => ({
  getSupabasePublicConfig: () => ({
    url: "https://example.supabase.co",
    publishableKey: "test-publishable-key",
  }),
}));

import { updateSession } from "@/lib/supabase/proxy";

describe("updateSession", () => {
  beforeEach(() => createServerClientMock.mockReset());

  it("verifies claims and forwards refreshed cookies and headers", async () => {
    const getClaims = vi.fn();
    createServerClientMock.mockImplementation((_url, _key, options) => {
      getClaims.mockImplementation(async () => {
        options.cookies.setAll(
          [
            {
              name: "sb-session",
              value: "refreshed",
              options: { path: "/", sameSite: "lax", maxAge: 34_560_000 },
            },
          ],
          new Headers({ "x-supabase-auth": "refreshed" }),
        );
        return { data: { claims: { sub: "user-1" } }, error: null };
      });
      return { auth: { getClaims } };
    });

    const request = new NextRequest("http://localhost:3000/search");
    const response = await updateSession(request);

    expect(getClaims).toHaveBeenCalledOnce();
    expect(response.cookies.get("sb-session")?.value).toBe("refreshed");
    expect(response.headers.get("x-supabase-auth")).toBe("refreshed");
  });
});
```

- [ ] **Step 2: Run the focused test and verify the intended failure**

Run:

```bash
npm test -- tests/supabase-proxy.test.ts
```

Expected: FAIL because the current proxy calls `getUser()` and does not propagate the second `setAll` headers argument.

- [ ] **Step 3: Implement the current Supabase SSR refresh pattern**

Change `src/lib/supabase/proxy.ts` so `setAll` accepts and copies `headersToSet`, then call `getClaims()` immediately after client construction:

```ts
export async function updateSession(
  request: NextRequest,
): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const { url, publishableKey } = getSupabasePublicConfig();
  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headersToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        headersToSet.forEach((value, key) => {
          response.headers.set(key, value);
        });
      },
    },
  });

  await supabase.auth.getClaims();
  return response;
}
```

Do not put logging, redirects, or other work between `createServerClient` and `getClaims()`.

- [ ] **Step 4: Run the focused test and static checks**

Run:

```bash
npm test -- tests/supabase-proxy.test.ts
npm run typecheck
npm run lint
```

Expected: the focused test passes and both static checks exit successfully.

- [ ] **Step 5: Commit the isolated session repair**

```bash
git add tests/supabase-proxy.test.ts src/lib/supabase/proxy.ts
git commit -m "fix: persist refreshed Supabase sessions"
```

### Task 2: Verify persistence through the real application boundary

**Files:**

- Modify only if a verified failure requires it: `src/lib/supabase/server.ts`, `src/proxy.ts`, `src/app/auth/actions.ts`
- Do not commit: `.env.local`, browser screenshots, or temporary logs

**Interfaces:**

- Consumes: the corrected `updateSession()` from Task 1 and the existing test account.
- Produces: evidence that a real password session remains valid after navigation, refresh, and a development-server restart.

- [ ] **Step 1: Run the complete deterministic verification suite**

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: all commands succeed. If formatting fails only because the new test is unformatted, run `npx prettier --write tests/supabase-proxy.test.ts src/lib/supabase/proxy.ts`, then repeat all five commands.

- [ ] **Step 2: Start one known development server**

```bash
npm run dev
```

Record the selected localhost port. Do not test against a second stale Next.js process.

- [ ] **Step 3: Exercise the real cookie lifecycle in the browser**

Using the existing SaveSort test account:

1. Sign in at `/login` and confirm the browser reaches `/search`.
2. Navigate to `/library`, refresh the page, and return to `/search`.
3. Stop and restart the development server on the same port.
4. Reload `/search` and confirm the protected application renders without another login.
5. Log out and confirm `/search` redirects to `/login`.

Expected: steps 1-4 retain the session; step 5 removes it.

- [ ] **Step 4: Diagnose before changing any additional authentication code**

If the manual check fails, record the exact URL, HTTP response, and server log first. Verify that the request contains an `sb-` cookie and that the proxy response preserves `Set-Cookie`. Do not add custom cookie lifetime settings unless the provider response proves the default persistent cookie is missing; `@supabase/ssr` 0.12.4 already supplies a persistent default.

- [ ] **Step 5: Commit only evidence-driven follow-up changes**

If Task 2 required a code change, add its focused regression test and commit only those files:

```bash
git add tests src/lib/supabase src/proxy.ts src/app/auth/actions.ts
git commit -m "fix: cover Supabase session lifecycle"
```

If no code change was required, do not create an empty commit.

## Plan self-review

- Spec coverage: proxy claim verification, cookie mirroring, response-header propagation, protected-route authorization, browser persistence, and logout are covered.
- Placeholder scan: every implementation and failure-handling step is concrete.
- Type consistency: the plan retains the existing `updateSession(request): Promise<NextResponse>` interface and uses the two-argument `setAll(cookiesToSet, headersToSet)` contract from `@supabase/ssr` 0.12.4.
