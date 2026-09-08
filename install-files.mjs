// Conservative installation ownership: never adopt an existing untracked file,
// and never overwrite/delete a managed file after the user has edited it.
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export function managedFiles(home, report) {
  const dir = join(home, ".pirate-radio");
  const manifest = join(dir, "install-manifest.json");
  let entries = {};
  try {
    const saved = JSON.parse(readFileSync(manifest, "utf8"));
    if (saved.version === 1 && saved.entries && typeof saved.entries === "object" && !Array.isArray(saved.entries)) entries = saved.entries;
  } catch { /* missing/corrupt manifest: preserve unknown files */ }
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  function remember(key, text) {
    if (text === undefined) delete entries[key];
    else entries[key] = hash(text);
    mkdirSync(dir, { recursive: true });
    const tmp = `${manifest}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2), { mode: 0o600 });
    renameSync(tmp, manifest);
  }
  function mayChange(key, current) {
    if (current === undefined || entries[key] === hash(current)) return true;
    report("skip (unmanaged or edited)", key);
    return false;
  }
  function backup(path, content) {
    const dest = join(dir, "install-backups", `${Date.now()}-${randomUUID()}.bak`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, { flag: "wx", mode: 0o600 });
    report(`backup of ${path}`, dest);
  }
  function currentFile(path) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) throw new Error(`Refusing to modify non-regular file: ${path}`);
      return readFileSync(path, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return undefined;
      throw e;
    }
  }
  function write(path, content) {
    const current = currentFile(path);
    if (!mayChange(path, current)) return;
    if (current !== undefined && current !== content) backup(path, current);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    remember(path, content);
    report("write", path);
  }
  function remove(path) {
    const current = currentFile(path);
    if (current === undefined || !mayChange(path, current)) return;
    unlinkSync(path);
    remember(path, undefined);
    report("remove", path);
  }
  // Shared config ownership is tracked at entry level; unrelated entries stay
  // editable. Back up the full file before any surgical config change.
  function writeConfig(path, content) {
    const current = currentFile(path);
    if (current === content) return;
    if (current !== undefined) backup(path, current);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    report("edit", path);
  }
  return { write, remove, mayChange, remember, writeConfig };
}
