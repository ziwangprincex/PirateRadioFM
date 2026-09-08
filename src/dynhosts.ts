// Recent source hosts retained for diagnostics and legacy state compatibility.
// Process cleanup uses session markers, never these domains.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dataDir } from "./session.js";
import { join } from "node:path";
import { hosts } from "./stations.js";
import { lifecycleTestMode } from "./lifecycle-mode.js";

const dir = dataDir();
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

// Legacy catalog helper; no longer used for process cleanup.
export function sweepHosts(): string[] {
  // Test bundles stay inside their isolated dynamic-host registry so a sweep in
  // a temp HOME can never match a real station host — and thus can never kill a
  // developer's actually-playing music.
  return lifecycleTestMode ? dynamicHosts() : [...hosts(), ...dynamicHosts()];
}

// Bounded recent-host history for diagnostics.
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
