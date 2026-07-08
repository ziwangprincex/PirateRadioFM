// HÖR Berlin (hoer.live) source. HÖR has no Icecast/HLS audio endpoint — its
// "radio" is a YouTube live stream embedded on the homepage (the same page
// shows the latest archived set outside broadcast hours). So: scrape the
// homepage for the current videoId, let yt-dlp resolve the direct audio URL,
// and play it through the existing local player pipeline. Needs yt-dlp on PATH.
import { execFileSync } from "node:child_process";
import { now } from "../state.js";
import * as player from "../player.js";
import * as spotify from "./spotify.js";
import * as applemusic from "./applemusic.js";
import { rememberHost } from "../dynhosts.js";

const HOME = "https://hoer.live/";
// Same UA the site is served to browsers with; the default node UA gets the
// page too today, but don't depend on it.
const UA = { "User-Agent": "Mozilla/5.0" };

async function currentVideo(): Promise<{ id: string; title: string | null }> {
  const r = await fetch(HOME, { headers: UA, redirect: "follow" });
  if (!r.ok) throw new Error(`hoer.live returned ${r.status}.`);
  const html = await r.text();
  // The homepage inlines the YT.Player init: videoId: 'coAiJFnN8Yw'
  const m = html.match(/videoId:\s*['"]([\w-]{6,20})['"]/);
  if (!m) throw new Error("Couldn't find the current show on hoer.live — the page layout may have changed.");
  const id = m[1];
  let title: string | null = null;
  try {
    const o = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
    if (o.ok) title = ((await o.json()) as { title?: string }).title ?? null;
  } catch {
    /* title is cosmetic */
  }
  return { id, title };
}

// yt-dlp -g prints the direct media URL (for live shows: an HLS manifest) —
// both mpv and ffplay play either. The id is regex-restricted to [\w-], and it
// goes through an argv array, so nothing can be injected.
function resolveAudioUrl(id: string): string {
  let out: string;
  try {
    out = execFileSync(
      "yt-dlp",
      ["-g", "-f", "bestaudio/best", `https://www.youtube.com/watch?v=${id}`],
      { encoding: "utf8", timeout: 60_000, windowsHide: true },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "HÖR streams via YouTube, which needs yt-dlp:\n" +
          "  macOS:   brew install yt-dlp\n" +
          "  Windows: winget install yt-dlp\n" +
          "  Linux:   pipx install yt-dlp  (or your package manager)",
      );
    throw new Error("yt-dlp couldn't resolve the HÖR stream (video may be members-only or region-locked).");
  }
  const url = out.trim().split("\n")[0];
  if (!url?.startsWith("http")) throw new Error("yt-dlp returned no stream URL for the HÖR show.");
  return url;
}

export async function play(): Promise<string> {
  const { id, title } = await currentVideo();
  const url = resolveAudioUrl(id);
  // Silence remote sources before starting the local stream (same pattern as
  // radio/podcast); player.play() kills any previous local player itself.
  if (now.source === "spotify") {
    try { await spotify.pause(); } catch { /* best effort */ }
  }
  if (now.source === "applemusic") applemusic.pauseIfRunning();
  // Resolved googlevideo hosts differ per session — register for orphan sweep.
  try { rememberHost(new URL(url).host); } catch { /* sweep just won't cover it */ }
  player.play(url, now.volume);
  now.state = "playing";
  now.source = "hoer";
  now.title = title ?? "HÖR Berlin";
  return `> HÖR Berlin — ${title ?? "current show"}`;
}

// Resolved stream URLs expire after a few hours, so resume/volume-change
// re-resolves from the homepage instead of reusing the old URL. This also
// naturally picks up the live stream if HÖR went on air in the meantime.
export async function resume(): Promise<string> {
  return play();
}
