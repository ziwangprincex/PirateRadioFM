// Manual/network station audit. Kept out of the default test suite so a
// temporary station or CI network outage does not fail unrelated code changes.
import { readFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile(new URL("../data/stations.json", import.meta.url), "utf8"));
const entries = Object.entries(catalog.genres ?? {}).flatMap(([genre, info]) =>
  (info.stations ?? []).map((station) => ({ genre, ...station })),
);
const concurrency = 6;
let cursor = 0;
const results = [];

async function probe(entry) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const started = Date.now();
  try {
    const response = await fetch(entry.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "PirateRadioFM station audit/1.0",
        "icy-metadata": "1",
        range: "bytes=0-4095",
      },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const reader = response.body?.getReader();
    if (reader) {
      await reader.read();
      await reader.cancel();
    }
    const ok = response.ok && contentType.toLowerCase().startsWith("audio/");
    return { ...entry, ok, status: response.status, contentType, finalUrl: response.url, ms: Date.now() - started,
      error: ok ? "" : `expected audio/*, received ${contentType || "no content-type"}` };
  } catch (error) {
    return { ...entry, ok: false, status: 0, contentType: "", finalUrl: entry.url, ms: Date.now() - started,
      error: error?.name === "AbortError" ? "timed out" : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function worker() {
  while (cursor < entries.length) {
    const entry = entries[cursor++];
    results.push(await probe(entry));
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
results.sort((a, b) => a.genre.localeCompare(b.genre) || a.name.localeCompare(b.name));
for (const result of results) {
  const mark = result.ok ? "OK " : "ERR";
  console.log(`${mark} ${result.genre.padEnd(10)} ${String(result.status).padEnd(3)} ${result.contentType.padEnd(18)} ${result.name} (${result.ms}ms)`);
  if (!result.ok) console.log(`    ${result.error}`);
}
const failures = results.filter((result) => !result.ok);
console.log(`\n${results.length - failures.length}/${results.length} station streams healthy.`);
if (failures.length) process.exitCode = 1;
