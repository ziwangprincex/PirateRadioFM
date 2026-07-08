// Persisted list of stream hosts we've played that are NOT in stations.json —
// podcast episode CDNs, mostly. The orphan sweep in player.ts matches players
// by host, so without this a podcast player that escaped the registry (crashed
// session, lost-update race) would survive a stop. Capped so the file — and the
// sweep's match set — can't grow without bound.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".pirate-radio");
const path = join(dir, "dynamic-hosts.json");
const CAP = 20;

export function dynamicHosts(): string[] {
  if (!existsSync(path)) return [];
  try {
    const arr = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(arr) ? arr.filter((h) => typeof h === "string") : [];
  } catch {
    return [];
  }
}

// Best-effort: losing a host here only weakens the orphan-sweep safety net for
// that one stream; the registry still tracks the live pid. Most-recent-first so
// the cap evicts the oldest hosts.
export function rememberHost(host: string): void {
  const h = host.toLowerCase();
  if (!h) return;
  try {
    const next = [h, ...dynamicHosts().filter((x) => x !== h)].slice(0, CAP);
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
  } catch {
    /* best effort */
  }
}
