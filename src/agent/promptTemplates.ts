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
        description: 'Map the architecture of this project — best with a large-context model like Kimi K3',
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
            "5. A Mermaid.js dependency diagram (in a ```mermaid code block) showing how the main modules depend on each other.\n\n" +
            "Cite specific files and paths throughout, not just module names in the abstract."
    },
    {
        id: 'security-auditor',
        label: 'Security Auditor',
        description: 'Systematic security review with concrete exploit scenarios, not theoretical findings',
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
        description: 'Find untested code paths across the project and write tests matching existing conventions',
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
