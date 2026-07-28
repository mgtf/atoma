1. read_file .atoma-probes.json — the machine-readable record {"version":1,"entries":[{"cmd","exitCode","stdout","stderr"}]} written by earlier phases. This is the PRIMARY input.
2. For each entry: run_shell the "cmd" verbatim; compare observed exit code, stdout and stderr byte-for-byte against the recorded values.
3. Only if the manifest is absent: parse the README’s ‘Verified invocations’ section instead (complete commands including quoted arguments), re-run each, compare against its explicit claims only.
4. list_files to confirm the deliverable files (and any fixtures referenced by the commands) exist.
5. If you executed invocations that the manifest does not record yet, write/merge them into .atoma-probes.json.
6. Report a pass/fail line per invocation in the == GROUND TRUTH == block; any mismatch is a FAILURE to report, never to silently fix.
