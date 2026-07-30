// Builds ready-to-run production bundles plus dedicated lifecycle-test bundles.
import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await rm(".test-dist", { recursive: true, force: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: ["src/index.ts", "src/cli.ts", "src/watchdog.ts", "src/selfcheck.ts"],
  outdir: "dist",
  define: { __RADIOHEAD_LIFECYCLE_TEST_MODE__: "false" },
});

// These bundles hard-code test mode at build time. They live in a separate
// directory and are only invoked by lifecyclecheck.js; production bundles have
// no runtime switch that can weaken process-token or orphan-sweep behavior.
await build({
  ...shared,
  entryPoints: {
    index: "src/index.ts",
    watchdog: "src/watchdog.ts",
    lifecyclecheck: "src/lifecyclecheck.ts",
  },
  outdir: ".test-dist/lifecycle",
  define: { __RADIOHEAD_LIFECYCLE_TEST_MODE__: "true" },
});

await build({
  ...shared,
  entryPoints: { processcheck: "src/processcheck.ts" },
  outdir: ".test-dist/lifecycle",
  define: { __RADIOHEAD_LIFECYCLE_TEST_MODE__: "false" },
});
