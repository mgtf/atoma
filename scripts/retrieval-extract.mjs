/** Host-only extraction. stdin is the captured source; stdout is extracted UTF-8. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseOffice } from 'officeparser';

// Dependency diagnostics must never become part of the document text.
console.log = console.info = console.debug = (...args) => console.error(...args);

try {
  const [format, scratch] = process.argv.slice(2);
  let bytes = readFileSync(0);
  const legacy = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' };
  if (Object.hasOwn(legacy, format)) {
    // Private profile: disable macros and link updates. No shared desktop instance.
    const profile = join(scratch, 'profile');
    mkdirSync(join(profile, 'user'), { recursive: true });
    writeFileSync(join(profile, 'user', 'registrymodifications.xcu'),
      '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">' +
      '<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>' +
      '<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item></oor:items>');
    const input = join(scratch, `source.${format}`);
    writeFileSync(input, bytes, { mode: 0o600 });
    execFileSync('soffice', [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--nologo',
      '--nodefault', '--norestore', '--convert-to', legacy[format], '--outdir', scratch, input],
    { timeout: 45_000, stdio: 'ignore' });
    bytes = readFileSync(join(scratch, `source.${legacy[format]}`));
  }
  const ast = await parseOffice(bytes, {
    fileType: legacy[format] ?? format, outputErrorToConsole: false,
    ocr: false, extractAttachments: false,
    decompressionLimits: { maxUncompressedBytes: 32_000_000, maxZipEntries: 5000, maxTableCells: 100_000 },
  });
  if (ast.warnings?.length) throw new Error('incomplete extraction');
  const text = ast.toText();
  if (!text.trim() || Buffer.byteLength(text) > 1_000_000 || text.includes('\0')) throw new Error('no bounded text');
  process.stdout.write(text);
} catch {
  process.exitCode = 1;
}
