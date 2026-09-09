import { haystackLaunchSchema } from '../../src/contracts/retrievalHaystack.js';
import { haystackTestRuntime as fixture } from '../../scripts/fixtures/haystack-test-runtime.mjs';

export function haystackTestRuntime(root: string, behavior = 'valid') {
  return haystackLaunchSchema.parse(fixture(root, behavior));
}
