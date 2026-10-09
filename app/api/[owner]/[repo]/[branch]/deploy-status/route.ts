import { type NextRequest } from "next/server";
import { createOctokitInstance } from "@/lib/utils/octokit";
import { getToken } from "@/lib/token";
import { createHttpError, toErrorResponse } from "@/lib/api-error";
import { requireApiUserSession } from "@/lib/session-server";

/**
 * Reports whether the site deploy for a commit has finished, using the commit status the hosting
 * integration (e.g. Vercel's GitHub integration) posts to GitHub.
 *
 * GET /api/[owner]/[repo]/[branch]/deploy-status?sha=<commit sha>
 *
 * Requires authentication. Set DEPLOY_STATUS_CONTEXT if your host posts under a name other than "Vercel".
 */

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ owner: string, repo: string, branch: string }> }
) {
  try {
    const params = await context.params;
    const sessionResult = await requireApiUserSession();
    if ("response" in sessionResult) return sessionResult.response;

    const { token } = await getToken(sessionResult.user, params.owner, params.repo);
    if (!token) throw createHttpError("Token not found", 401);

    const sha = request.nextUrl.searchParams.get("sha") || "";
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw createHttpError("A valid commit sha is required.", 400);

    const wanted = process.env.DEPLOY_STATUS_CONTEXT || "Vercel";
    const octokit = createOctokitInstance(token);
    const response = await octokit.rest.repos.getCombinedStatusForRef({
      owner: params.owner,
      repo: params.repo,
      ref: sha,
    });

    const match = response.data.statuses.find((s) => s.context === wanted);
    return Response.json({
      status: "success",
      data: {
        // "none" until the host reports in; then pending | success | failure | error
        state: match?.state ?? "none",
        description: match?.description ?? null,
        targetUrl: match?.target_url ?? null,
      },
    });
  } catch (error: any) {
    console.error(error);
    return toErrorResponse(error);
  }
}
