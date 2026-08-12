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
});
