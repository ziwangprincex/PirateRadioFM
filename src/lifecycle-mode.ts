// Replaced at bundle time. Production bundles hard-code false; the dedicated
// lifecycle-test bundles hard-code true. This is intentionally not controlled
// by an environment variable, so production safety behavior cannot be disabled
// at runtime.
declare const __RADIOHEAD_LIFECYCLE_TEST_MODE__: boolean;
export const lifecycleTestMode = __RADIOHEAD_LIFECYCLE_TEST_MODE__;
