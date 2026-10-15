import { describe, expect, test } from "bun:test";
import { outlineMarkdown, renderMarkdownOutline } from "../lib/code-outline";

describe("Markdown AST table-of-contents outline", () => {
	test("parses hierarchy of headings while ignoring code blocks", () => {
		const doc = `# Root Title

Introduction paragraph.

## Section 1
Content here.

\`\`\`markdown
## Fake Header inside code block
\`\`\`

~~~sh
### Another fake header
~~~

### Subsection 1.1
Detail here.

## Section 2
Closing section.
`;

		const outline = outlineMarkdown(doc);
		expect(outline).toBeDefined();
		expect(outline?.totalLines).toBe(20);
		expect(outline?.headings.length).toBe(4);

		expect(outline?.headings[0]).toEqual({
			level: 1,
			title: "Root Title",
			line: 1,
		});

		expect(outline?.headings[1]).toEqual({
			level: 2,
			title: "Section 1",
			line: 5,
		});

		expect(outline?.headings[2]).toEqual({
			level: 3,
			title: "Subsection 1.1",
			line: 16,
		});

		expect(outline?.headings[3]).toEqual({
			level: 2,
			title: "Section 2",
			line: 19,
		});
	});

	test("parses setext headings (=== and ---)", () => {
		const doc = `Title One\n=========\n\nIntro\n\nSubtitle Two\n------------\nBody\n`;
		const outline = outlineMarkdown(doc);
		expect(outline).toBeDefined();
		expect(outline?.headings.length).toBe(2);
		expect(outline?.headings[0]).toEqual({ level: 1, title: "Title One", line: 1 });
		expect(outline?.headings[1]).toEqual({ level: 2, title: "Subtitle Two", line: 6 });
	});
	test("skips YAML front matter before parsing headings", () => {
		const doc = `---
name: test-skill
description: sample description
---

# Real Heading
Some body.

## Subsection
Detail.
`;
		const outline = outlineMarkdown(doc);
		expect(outline).toBeDefined();
		expect(outline?.headings.length).toBe(2);
		expect(outline?.headings[0]).toEqual({ level: 1, title: "Real Heading", line: 6 });
		expect(outline?.headings[1]).toEqual({ level: 2, title: "Subsection", line: 9 });
	});

	test("renders structured TOC lines with relative indents and line targets", () => {
		const doc = `# Architecture
Overview.

## Components
### Storage
### Networking
`;

		const outline = outlineMarkdown(doc);
		expect(outline).toBeDefined();
		const rows = renderMarkdownOutline(outline!, "docs/arch.md");
		expect(rows[0]).toBe("docs/arch.md · markdown · 6 lines · 4 sections");
		expect(rows[1]).toBe("  # Architecture  :1");
		expect(rows[2]).toBe("    ## Components  :4");
		expect(rows[3]).toBe("      ### Storage  :5");
		expect(rows[4]).toBe("      ### Networking  :6");
	});
});
