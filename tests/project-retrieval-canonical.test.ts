import { describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { ensureCanonicalProjectDocsL1, ensureCanonicalFileScribeL1, ensureCanonicalL1, ensureCanonicalHttpL1 } from '../src/atoms/capability.js';
import { projectRetrievalDeclaration } from '../src/tools/projectRetrieval.js';
import { makeTools } from './helpers/factories.js';

describe('dedicated project documentation molecule', () => {
  it('adds only the intended scope to an existing registry, preserves unrelated trust, and refreshes idempotently', () => {
    const db = openDb(':memory:'); const registry = new AtomRegistry(db);
    try {
      const worker = makeTools(['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'record_probe', 'fetch_url', 'start_node_server', 'start_static_server', 'validate_html']);
      const unrelated = [ensureCanonicalFileScribeL1(registry, worker), ensureCanonicalL1(registry, worker, 'smoke'), ensureCanonicalHttpL1(registry, worker)];
      unrelated.forEach(type => registry.recordSuccess(type.name));
      expect(ensureCanonicalProjectDocsL1(registry, worker)).toBeUndefined();
      const all = [...worker, projectRetrievalDeclaration];
      const added = ensureCanonicalProjectDocsL1(registry, all)!;
      expect(added.tools.map(t => t.name)).toContain(projectRetrievalDeclaration.name);
      expect(added.tools.map(t => t.name)).not.toContain('validate_html');
      expect(added.description).toContain('authorized project documentation');
      registry.recordSuccess(added.name);
      expect(ensureCanonicalProjectDocsL1(registry, all)).toMatchObject({ atomId: added.atomId, version: added.version, successes: 1 });
      const disabled = ensureCanonicalProjectDocsL1(registry, worker)!;
      expect(disabled.tools.map(t => t.name)).not.toContain(projectRetrievalDeclaration.name);
      expect(disabled.systemPrompt).not.toContain(projectRetrievalDeclaration.name);
      expect(disabled.successes).toBe(0);
      expect(ensureCanonicalProjectDocsL1(registry, all)?.atomId).toBe(added.atomId);
      for (const type of unrelated) expect(registry.getByName(type.name)).toMatchObject({ version: type.version, successes: 1, tools: type.tools });
    } finally { db.close(); }
  });
});
