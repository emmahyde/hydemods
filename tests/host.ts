// Hydemods uses the running OMP's modules, not a second installed SDK copy.
// Standalone tests resolve those same peer imports from the installed launcher.
if (!Bun.which("omp")) {
	// Without a host there is nothing to exercise; skip the suite with a clear reason instead of
	// failing every file on an unresolvable `@oh-my-pi/*` import. `bun run typecheck` still runs.
	console.warn("\nhydemods tests skipped: `omp` is not on PATH (the tests run against the installed OMP).\n");
	process.exit(0);
}
