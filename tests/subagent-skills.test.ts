import { describe, expect, test } from "bun:test";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { withoutSkillListing } from "../lib/subagent-skills";

const skills = [
	{ name: "zebra-skill", description: "Handles zebra things.", filePath: "/tmp/zebra/SKILL.md", baseDir: "/tmp/zebra", source: "user" },
] as unknown as Skill[];
const rules = [{ name: "zebra-rule", description: "Zebra rule.", path: "/tmp/zebra-rule.md" }];
const contextFiles = [{ path: "/tmp/AGENTS.md", content: "<skills>\n- keep-me: context file text\n</skills>" }];

const render = async (customPrompt?: string) =>
	(await buildSystemPrompt({ cwd: "/tmp", skills, rules, contextFiles, toolNames: ["read", "bash"], customPrompt })).systemPrompt.join("\n");

describe("subagent skill listing", () => {
	for (const [label, custom] of [["default", undefined], ["custom", "You are a custom agent."]] as const) {
		test(`drops the host's ${label} skill listing and keeps everything else`, async () => {
			const before = await render(custom);
			expect(before).toContain("zebra-skill");
			const after = withoutSkillListing([before])?.join("\n");
			expect(after).toBeDefined();
			expect(after).not.toContain("zebra-skill");
			expect(after).toContain("zebra-rule");
			expect(after).toContain("keep-me: context file text");
		});
	}

	test("leaves a prompt without a listing alone", () => {
		expect(withoutSkillListing(["no skills here", "<skills>\n- bare: block\n</skills>"])).toBeUndefined();
	});
});
