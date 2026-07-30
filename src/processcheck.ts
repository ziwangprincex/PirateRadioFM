#!/usr/bin/env node
// Production-mode probe used by lifecycle integration tests. Kept tiny so the
// PID-token behavior is exercised with the same compile-time settings as the
// shipped bundles.
import { sameProcess } from "./proc.js";
const pid = Number(process.argv[2]);
const token = process.argv[3] || null;
process.stdout.write(String(sameProcess(pid, token)));
