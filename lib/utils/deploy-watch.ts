import { toast } from "sonner";
import { normalizePath } from "@/lib/utils/file";

const POLL_MS = 5000;
const GIVE_UP_MS = 8 * 60 * 1000;

// src/content/countries/<country>/<city>.md -> <live site>/<country>/#<city> (null when no live site is configured)
export const getLiveSiteUrl = (path: string): string | null => {
  const base = process.env.NEXT_PUBLIC_LIVE_SITE_URL?.replace(/\/+$/, "");
  const match = normalizePath(path).match(/(?:^|\/)countries\/([^/]+)\/([^/]+)\.md$/);
  if (!base || !match) return null;
  return `${base}/${match[1]}/#${match[2]}`;
};

let activeWatch = 0;

// After a save: show a "deploying" toast, poll the commit's deploy status, then offer a link to the updated page.
export const watchDeploy = ({
  owner,
  repo,
  branch,
  sha,
  liveUrl,
  label,
}: {
  owner: string;
  repo: string;
  branch: string;
  sha: string;
  liveUrl: string;
  label: string;
}) => {
  const watchId = ++activeWatch; // a newer save replaces an older watcher
  const toastId = `deploy-${owner}-${repo}`;
  const startedAt = Date.now();
  const url = `/api/${owner}/${repo}/${encodeURIComponent(branch)}/deploy-status?sha=${encodeURIComponent(sha)}`;

  toast.loading(`Updating the live site (${label})…`, { id: toastId, duration: Infinity });

  const poll = async () => {
    if (watchId !== activeWatch) return;
    try {
      const response = await fetch(url);
      const payload = await response.json();
      if (watchId !== activeWatch) return;
      if (!response.ok || payload.status !== "success") throw new Error(payload.message || `HTTP ${response.status}`);

      const { state, description, targetUrl } = payload.data as { state: string; description: string | null; targetUrl: string | null };
      if (state === "success") {
        toast.success(`Live site updated: ${label}`, {
          id: toastId,
          duration: 20000,
          action: { label: "Open", onClick: () => window.open(liveUrl, "_blank", "noopener") },
        });
        return;
      }
      if (state === "failure" || state === "error") {
        if (/cancel/i.test(description ?? "")) {
          toast.dismiss(toastId); // replaced by a newer deploy, which has its own toast
          return;
        }
        toast.error("The live site deploy failed", {
          id: toastId,
          duration: 30000,
          description: description ?? undefined,
          action: targetUrl ? { label: "View logs", onClick: () => window.open(targetUrl, "_blank", "noopener") } : undefined,
        });
        return;
      }
    } catch (error) {
      console.error(error); // transient (network, rate limit): keep polling until the deadline
    }

    if (Date.now() - startedAt > GIVE_UP_MS) {
      toast.message("Still deploying", {
        id: toastId,
        duration: 15000,
        description: "The live site hasn't reported back yet. It may still be building.",
        action: { label: "Open anyway", onClick: () => window.open(liveUrl, "_blank", "noopener") },
      });
      return;
    }
    setTimeout(poll, POLL_MS);
  };

  setTimeout(poll, 3000);
};
