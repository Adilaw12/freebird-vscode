// src/agent/promptTemplates.ts — built-in starting-point prompts for common
// agent tasks. Selected via the "Freebird: Use Prompt Template" command,
// which populates the chat input for the user to edit before sending (not
// sent automatically) — these are a starting point, not a fixed action.

export interface PromptTemplate {
    id: string;
    label: string;
    description: string;
    prompt: string;
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
    {
        id: 'codebase-cartographer',
        label: 'Codebase Cartographer',
        description: 'Map the architecture of this project — best with a large-context model like Kimi K3 (thorough — can take a couple of minutes)',
        prompt:
            "Act as a codebase cartographer. Build a map of this project's architecture.\n\n" +
            "You have a large context window — take advantage of it. Read broadly rather than " +
            "searching narrowly: start with the directory structure, then read entry points, core " +
            "modules, and configuration files directly rather than relying only on keyword search, " +
            "so you're holding the real shape of the project, not a guess reconstructed from fragments.\n\n" +
            "Produce:\n" +
            "1. A high-level architecture overview — the main modules/layers and how they depend on each other.\n" +
            "2. The key abstractions and how data actually flows through the system end to end.\n" +
            "3. Conventions that are used consistently enough to matter (naming, error handling, testing style).\n" +
            "4. Anything that looks like real technical debt or an inconsistency worth flagging — not " +
            "stylistic nitpicks, things that would actually confuse someone new to this codebase.\n" +
            "5. A dependency diagram showing how the main modules depend on each other. This MUST be valid " +
            "Mermaid.js syntax (e.g. `graph TD` or `flowchart TD`) inside a fenced code block whose language " +
            "tag is exactly `mermaid` — for example:\n" +
            "```mermaid\ngraph TD\n  A[Module A] --> B[Module B]\n```\n" +
            "Do NOT draw the diagram as ASCII/box-drawing art, and do NOT use a plain/untagged code fence for " +
            "it — it must be real Mermaid syntax in a ```mermaid block so it renders as an actual diagram.\n\n" +
            "Cite specific files and paths throughout, not just module names in the abstract."
    },
    {
        id: 'code-hotspots',
        label: 'Code Hotspots & Contribution Map',
        description: 'Which files change together and which churn the most — a co-change and hotspot map from real git history, not a raw commit log',
        prompt:
            "Act as a code archaeologist. Use git history — not just the current file tree — to find where " +
            "real risk and activity actually concentrate in this codebase.\n\n" +
            "First, sanity-check what you're working with before analyzing anything:\n" +
            "- Confirm this is a real git repository with usable history (`git rev-parse --is-inside-work-tree`).\n" +
            "- Check `git rev-parse --is-shallow-repository` — if true, history is truncated (common in CI " +
            "checkouts and some cloud sandboxes). Say so plainly in your output rather than presenting a " +
            "partial picture as if it were complete.\n" +
            "- If the repo has fewer than ~20 commits, say history is too thin for a meaningful hotspot map " +
            "instead of forcing an analysis out of it.\n\n" +
            "When you run `git log`, bound it deliberately — the last 200 commits or the last 6 months, " +
            "whichever is smaller — both so the analysis reflects current activity rather than the whole " +
            "project's lifetime, and so the output doesn't blow past tool output limits. Avoid pipe (`|`) and " +
            "quote characters in any `--pretty=format` string you construct; they're interpreted differently " +
            "across shells (this runs through whatever shell the user's OS defaults to) and can silently break " +
            "the command or truncate output. If a git command errors, read the actual error and adjust — don't " +
            "retry the same command unchanged.\n\n" +
            "From the history, produce:\n" +
            "1. **File churn ranking** — the files that changed most often in the analyzed window. High churn " +
            "isn't automatically bad, but a high-churn file with also-high complexity is worth flagging as a " +
            "real risk concentration, not just a busy area.\n" +
            "2. **Co-change pairs** — files that are frequently modified in the same commit despite not being " +
            "an obvious pair (e.g. not just a `.ts` and its own test file). This surfaces coupling that isn't " +
            "visible from imports or file structure alone.\n" +
            "3. **Contribution pattern** — who's been actively working in which areas recently, if author info " +
            "is available and the repo isn't a solo project. Skip this section entirely rather than guessing " +
            "if the repo has one contributor or author data is unavailable.\n" +
            "4. A diagram showing the strongest co-change relationships as a graph — files as nodes, edges " +
            "weighted or labelled by how often they change together. This MUST be valid Mermaid.js syntax " +
            "(e.g. `graph TD` or `flowchart TD`) inside a fenced code block whose language tag is exactly " +
            "`mermaid`:\n" +
            "```mermaid\ngraph TD\n  A[fileA.ts] ---|8 commits| B[fileB.ts]\n```\n" +
            "Do NOT draw it as ASCII/box-drawing art, and do NOT use a plain/untagged code fence — it must be " +
            "real Mermaid syntax so it renders as an actual diagram. Keep it to the strongest 10-15 " +
            "relationships, not every pair you found — a graph with everything in it shows nothing.\n\n" +
            "Cite exact file paths throughout. If the data doesn't support a clear finding for a section, say " +
            "so directly rather than manufacturing a pattern from noise."
    },
    {
        id: 'security-auditor',
        label: 'Security Auditor',
        description: 'Systematic security review with concrete exploit scenarios, not theoretical findings (thorough — can take a couple of minutes)',
        prompt:
            "Act as a security auditor. Review this codebase (or the specific files/area I point you at) " +
            "for real security vulnerabilities: injection (SQL/command/prompt), auth and session handling, " +
            "secrets and credential management, path traversal, SSRF, insecure deserialization, and OWASP " +
            "Top 10 issues generally.\n\n" +
            "For every finding:\n" +
            "- Cite the exact file and line.\n" +
            "- Describe the concrete failure scenario — specific input or conditions that trigger it, not " +
            "just \"this could be a vulnerability.\"\n" +
            "- Rate severity based on actual exploitability given how this code is really invoked, not worst-case abstraction.\n" +
            "- Suggest a specific fix.\n\n" +
            "Don't flag purely theoretical issues with no realistic attack path in this codebase — I'd rather " +
            "have fewer, real findings than a long list padded with speculation. Do not alter the functional " +
            "logic while fixing an issue — the fix should close the vulnerability without changing intended behavior."
    },
    {
        id: 'multi-file-test-engineer',
        label: 'Multi-File Test Engineer',
        description: 'Find untested code paths across the project and write tests matching existing conventions (thorough — can take a couple of minutes)',
        prompt:
            "Act as a test engineer. Find the most important untested or under-tested code paths across " +
            "this project and write tests for them.\n\n" +
            "First, read the existing test suite to learn the project's actual conventions — test runner, " +
            "assertion style, file naming and location, how mocks/fixtures are set up — and match that style " +
            "rather than introducing a different pattern.\n\n" +
            "Prioritize, in order:\n" +
            "1. Business logic where a bug has real consequences (money, auth, data loss).\n" +
            "2. Edge cases that are easy to get wrong (empty input, concurrency, boundary values).\n" +
            "3. Regression coverage for anything that reads like it's been a source of bugs before.\n\n" +
            "After writing the tests, run them and fix anything that fails before finishing."
    }
];
