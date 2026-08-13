import { describe, it, expect } from 'vitest';
import * as api from '../src/index.js';

describe('public tool API', () => {
  it('exports a factory for every builtin in defaultBuiltinTools', () => {
    for (const name of [
      'writeFileTool',
      'editFileTool',
      'readFileTool',
      'listFilesTool',
      'runShellTool',
      'recordProbeTool',
      'startStaticServerTool',
      'validateHtmlTool',
      'fetchUrlTool',
      'startNodeServerTool',
    ]) {
      expect(typeof api[name as keyof typeof api], name).toBe('function');
    }
  });

  it('exports the element catalogue and all three agent-rank taxonomies', () => {
    expect(api.BUILTIN_TOOL_ELEMENTS).toHaveLength(10);
    expect(api.elementForTool('read_file')).toMatchObject({
      name: 'Lithium',
      symbol: 'Li',
    });
    expect(api.MOLECULES[0]?.name).toBe('Water');
    expect(api.CELLS[0]?.name).toBe('Tracheid');
    expect(api.TISSUES[0]?.name).toBe('Meristem');
  });

  it('exports taxonomy-first class names alongside compatibility aliases', () => {
    expect(api.Agent).toBe(api.Atom);
    expect(api.AgentRegistry).toBe(api.AtomRegistry);
    expect(api.MoleculeAgent).toBe(api.L1Atom);
    expect(api.CellAgent).toBe(api.L2Atom);
    expect(api.TissueAgent).toBe(api.L3Atom);
  });
});
