import { getFileSize } from "@/lib/utils/file";

// Turns a failed upload into a toast message: which file, how big, what the server said, and what to try.
export const describeUploadError = (
  error: unknown,
  file: { name: string; size: number },
): { title: string; description: string } => {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const reason = raw.trim() || "Unknown error";

  let hint = "";
  if (/\b413\b|payload too large|FUNCTION_PAYLOAD_TOO_LARGE|too large/i.test(raw)) {
    hint = "The file is bigger than the server accepts per request (about 4.5 MB). Try a smaller photo.";
  } else if (/failed to fetch|networkerror|load failed|network/i.test(raw)) {
    hint = "Network problem: check your connection and try again.";
  } else if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden/i.test(raw)) {
    hint = "Not authorized: sign in again, and check that the GitHub App can write to this repository.";
  } else if (/\b(500|502|503|504)\b|timed? ?out|timeout/i.test(raw)) {
    hint = "The server hit an error or timed out. Wait a moment and try again.";
  } else if (/failed to read|decode|invalid|unsupported/i.test(raw)) {
    hint = "The image could not be read. Try exporting it as a JPEG or PNG.";
  }

  return {
    title: `Couldn't upload ${file.name}`,
    description: [`${getFileSize(file.size)}: ${reason}`, hint].filter(Boolean).join("\n"),
  };
};
