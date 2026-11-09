/**
 * Subagents never carry the `<skills>` listing, whatever the `skillful` setting says.
 *
 * OMP renders the listing from one of two templates, each with a fixed lead-in before the
 * block. Matching the lead-in as well keeps a stray `<skills>` line in a context file
 * untouched. Autoloaded agent skills arrive as messages and `skill://` reads still work.
 */
const SKILL_LISTING =
	/^(?:Matching skill → MUST read `skill:\/\/<name>` first\.|Skills are specialized knowledge\. Scan descriptions for your task domain\.\nIf a skill applies, you MUST read `skill:\/\/<name>` before proceeding\.)\n<skills>\n[\s\S]*?^<\/skills>\n?/gm;

/** The system prompt without its skill listing, or undefined when it has none. */
export function withoutSkillListing(systemPrompt: readonly string[]): string[] | undefined {
	let changed = false;
	const stripped = systemPrompt.map(block => {
		const next = block.replace(SKILL_LISTING, "");
		if (next !== block) changed = true;
		return next;
	});
	return changed ? stripped : undefined;
}
