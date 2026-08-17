import { redirect } from "next/navigation";
import { z } from "zod";

import { requireUser } from "@/lib/auth/require-user";
import { createAuthorizationCode } from "@/lib/desktop/sessions";
import { buildRedirect, isLoopbackRedirectUri } from "@/lib/desktop/tokens";

const authorizeSchema = z.object({
  redirect_uri: z.string().min(1).max(512).refine(isLoopbackRedirectUri, {
    message: "The desktop app must listen on this computer.",
  }),
  state: z.string().min(8).max(256),
  code_challenge: z.string().min(32).max(256),
  code_challenge_method: z.literal("S256"),
  device_name: z.string().trim().min(1).max(120).default("Windows PC"),
});

type AuthorizeParams = z.infer<typeof authorizeSchema>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DesktopAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const parsed = authorizeSchema.safeParse({
    redirect_uri: firstValue(params.redirect_uri),
    state: firstValue(params.state),
    code_challenge: firstValue(params.code_challenge),
    code_challenge_method: firstValue(params.code_challenge_method),
    device_name: firstValue(params.device_name) ?? undefined,
  });

  if (!parsed.success) {
    return (
      <main className="content-width" style={{ padding: "48px 0" }}>
        <h1>That link isn&apos;t valid</h1>
        <p>
          Start the connection from the SaveSort desktop app again. If it keeps
          failing, update the app to the latest version.
        </p>
      </main>
    );
  }

  const request = parsed.data;
  const query = new URLSearchParams({
    redirect_uri: request.redirect_uri,
    state: request.state,
    code_challenge: request.code_challenge,
    code_challenge_method: request.code_challenge_method,
    device_name: request.device_name,
  }).toString();

  try {
    await requireUser();
  } catch {
    redirect(
      `/login?next=${encodeURIComponent(`/desktop/authorize?${query}`)}`,
    );
  }

  async function approve() {
    "use server";
    const { user } = await requireUser();
    const approved: AuthorizeParams = request;
    const code = await createAuthorizationCode(
      user.id,
      approved.code_challenge,
      approved.redirect_uri,
      approved.device_name,
    );
    redirect(
      buildRedirect(approved.redirect_uri, {
        code,
        state: approved.state,
      }),
    );
  }

  return (
    <main
      className="content-width"
      style={{ padding: "48px 0", maxWidth: 560 }}
    >
      <h1>Connect SaveSort Desktop</h1>
      <p>
        <strong>{request.device_name}</strong> is asking to sync an Obsidian
        vault on this computer with your SaveSort library.
      </p>
      <p>Approving lets the app:</p>
      <ul>
        <li>Upload Markdown notes from the vault you choose</li>
        <li>Keep those notes up to date as you edit them</li>
        <li>Remove a synced note when you delete it locally</li>
      </ul>
      <p>
        It cannot read your other saved items, change your password, or sign in
        to the website as you. You can disconnect this device at any time.
      </p>
      <form action={approve}>
        <button className="button button-primary" type="submit">
          Approve and connect
        </button>
      </form>
    </main>
  );
}
