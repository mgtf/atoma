1. Enumerate the invocations actually run in prior phases (happy-path + each error case) by reading their real stdout/stderr/exit codes, not by assumption.
2. For each, run_shell <cmd> for <entry> with derived args from its actual usage string, capture exact output.
3. write_file README.md with: install note, each verified invocation + real output excerpt, fixture file contents, parsing/behavior rules inferred from code, exit codes table.
4. Re-run_shell the happy-path and at least one error case; diff against README text.
5. read_file README.md to confirm write. 6. list workspace files.
