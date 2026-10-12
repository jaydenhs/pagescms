import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accountTable, userTable } from "@/db/schema";
import { createOctokitInstance } from "@/lib/utils/octokit";

type GithubAccountRow = typeof accountTable.$inferSelect;
const refreshesInFlight = new Map<string, Promise<GithubAccountRow>>();

// GitHub Apps can issue user tokens that expire after 8 hours (with a refresh token good for ~6 months).
// Swap in a fresh token before it is used so the user stays signed in; refresh tokens are single-use, so share one refresh per account.
const refreshGithubAccount = (account: GithubAccountRow): Promise<GithubAccountRow> => {
  const running = refreshesInFlight.get(account.id);
  if (running) return running;

  const job = (async () => {
    try {
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.GITHUB_APP_CLIENT_ID,
          client_secret: process.env.GITHUB_APP_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: account.refreshToken,
        }),
      });
      const data = await response.json();
      if (!response.ok || data.error || !data.access_token) {
        console.warn("[auth] github token refresh failed", { status: response.status, error: data.error });
        return account;
      }

      const now = Date.now();
      const patch = {
        accessToken: data.access_token as string,
        refreshToken: (data.refresh_token as string | undefined) ?? account.refreshToken,
        accessTokenExpiresAt: data.expires_in ? new Date(now + Number(data.expires_in) * 1000) : null,
        refreshTokenExpiresAt: data.refresh_token_expires_in
          ? new Date(now + Number(data.refresh_token_expires_in) * 1000)
          : account.refreshTokenExpiresAt,
        updatedAt: new Date(),
      };
      await db.update(accountTable).set(patch).where(eq(accountTable.id, account.id));
      return { ...account, ...patch };
    } catch (error) {
      console.warn("[auth] github token refresh error", error);
      return account;
    } finally {
      refreshesInFlight.delete(account.id);
    }
  })();
  refreshesInFlight.set(account.id, job);
  return job;
};

// Read the linked GitHub OAuth account for a user, refreshing an expired access token first.
const getGithubAccount = cache(async (userId: string) => {
  const account = await db.query.accountTable.findFirst({
    where: and(
      eq(accountTable.userId, userId),
      eq(accountTable.providerId, "github")
    )
  });
  if (!account?.refreshToken || !account.accessTokenExpiresAt) return account;

  const now = Date.now();
  const accessExpired = account.accessTokenExpiresAt.getTime() < now + 60_000;
  const refreshUsable = !account.refreshTokenExpiresAt || account.refreshTokenExpiresAt.getTime() > now;
  return accessExpired && refreshUsable ? refreshGithubAccount(account) : account;
});

const getGithubId = cache(async (userId: string): Promise<number | null> => {
  const account = await getGithubAccount(userId);
  if (!account?.accountId) return null;

  const githubId = Number(account.accountId);
  return Number.isInteger(githubId) ? githubId : null;
});

// Refresh GitHub-derived profile fields after login without overwriting custom names.
const syncGithubProfileOnLogin = async (userId: string) => {
  const [user, githubAccount] = await Promise.all([
    db.query.userTable.findFirst({
      where: eq(userTable.id, userId),
    }),
    getGithubAccount(userId),
  ]);

  if (!user || !githubAccount?.accessToken) return;

  const octokit = createOctokitInstance(githubAccount.accessToken);
  const { data: profile } = await octokit.rest.users.getAuthenticated();

  const nextGithubUsername = profile.login ?? null;
  const nextImage = profile.avatar_url ?? null;
  const nextName = profile.name ?? profile.login ?? user.name;

  const patch: Partial<typeof userTable.$inferInsert> = {};

  if (user.githubUsername !== nextGithubUsername) {
    patch.githubUsername = nextGithubUsername;
  }

  if ((user.image ?? null) !== nextImage) {
    patch.image = nextImage;
  }

  // Preserve custom display names; only refresh names that still mirror GitHub identity.
  if (user.name.trim() === "" || user.name === user.githubUsername) {
    if (user.name !== nextName) {
      patch.name = nextName;
    }
  }

  if (Object.keys(patch).length === 0) return;

  await db
    .update(userTable)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(userTable.id, userId));
};

export { getGithubAccount, getGithubId, syncGithubProfileOnLogin };
