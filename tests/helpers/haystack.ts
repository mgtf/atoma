import { haystackLaunchSchema, HAYSTACK_LAUNCH_ENV } from '../../src/contracts/retrievalHaystack.js';
import { haystackTestRuntime as fixture } from '../../scripts/fixtures/haystack-test-runtime.mjs';

export function haystackTestRuntime(root: string, behavior = 'valid') {
  return haystackLaunchSchema.parse(fixture(root, behavior));
}

/** Coordinator tests keep the real receipt path and replace only the ranking process. */
export function haystackTestEnvironment(root: string): NodeJS.ProcessEnv {
  return { [HAYSTACK_LAUNCH_ENV]: JSON.stringify(haystackTestRuntime(root)) };
}
