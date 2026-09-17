// backend/lib/templateCatalog.js — server-side sibling of
// src/agent/promptTemplates.ts, for templates gated behind the paid template
// library. Lives ONLY in this deployment, never in the extension's .vsix —
// that's the whole point (see api/templates.js for the entitlement gate).
//
// Every prompt assumes the same tool set the free templates do: read_file,
// search_code, search_codebase_semantic, edit_file, run_command, git_status,
// create_diagram, etc. — nothing here requires capabilities Freebird's agent
// loop doesn't already have.
//
// Deliberately NOT included here: an "AI-Context Generator" (.freebird/rules.md
// author) was brainstormed alongside these but flagged as a free-tier
// candidate instead — it makes every other template (paid or free) work
// better by teaching the agent the project's conventions, so it's a
// loss-leader, not something to gate. Add it to src/agent/promptTemplates.ts
// separately if/when that's picked up, not here.

export const TEMPLATE_CATALOG = [
    // ── Migration & Modernization ────────────────────────────────────────────
    {
        id: 'framework-migration-planner',
        label: 'Framework Migration Planner',
        description: 'Plan a framework/language migration (JS→TS, class→hooks, CommonJS→ESM, REST→GraphQL) with a concrete, incremental path',
        group: 'migration',
        tier: 'paid',
        prompt:
            "Act as a migration planner. I'll tell you the source and target (e.g. JavaScript to TypeScript, " +
            "class components to hooks, CommonJS to ESM, REST to GraphQL) — analyze this codebase and produce " +
            "an incremental migration plan for it.\n\n" +
            "Requirements for the plan:\n" +
            "1. Break the migration into ordered steps where each step leaves the codebase in a working, " +
            "shippable state — no long-lived broken intermediate state where half the code is on the old " +
            "pattern and half on the new with nothing actually running.\n" +
            "2. Identify the riskiest/highest-blast-radius parts first (shared utilities, widely-imported " +
            "modules, anything with many callers) so problems surface early, not on the last file.\n" +
            "3. Call out anything that can't be mechanically migrated and needs a human decision (ambiguous " +
            "types, behavior that subtly depends on the old pattern).\n" +
            "4. Note what should be verified after each step (typecheck, existing tests, a manual smoke check).\n\n" +
            "Cite specific files and the real number of call sites affected — don't estimate scope in the " +
            "abstract when you can grep for the actual count."
    },
    {
        id: 'dependency-upgrade-auditor',
        label: 'Dependency Upgrade Auditor',
        description: 'Find outdated/vulnerable dependencies and plan a safe upgrade path with real breaking-change research',
        group: 'migration',
        tier: 'paid',
        prompt:
            "Act as a dependency upgrade auditor. Review this project's dependencies (package.json/requirements.txt/" +
            "go.mod/etc., whatever this project uses) for ones that are outdated, deprecated, or have known " +
            "vulnerabilities.\n\n" +
            "For each dependency worth upgrading:\n" +
            "- Current version vs. latest stable version.\n" +
            "- Whether the upgrade is a patch/minor (usually safe) or major (check for breaking changes) bump.\n" +
            "- Real breaking changes that affect how THIS codebase actually uses the package — check actual " +
            "usage in this repo, not just the changelog in the abstract.\n" +
            "- A safe upgrade order — dependencies other packages rely on first, leaf dependencies last.\n\n" +
            "Prioritize security-relevant upgrades and anything actively deprecated over cosmetic version bumps. " +
            "After presenting the plan, if I confirm, upgrade the ones we agree on and run the test suite to " +
            "verify nothing broke."
    },
    {
        id: 'state-management-migrator',
        label: 'State Management Migrator',
        description: 'Migrate between state management libraries (Redux→Zustand/Context, Vuex→Pinia, etc.)',
        group: 'migration',
        tier: 'paid',
        prompt:
            "Act as a state management migration specialist. Help migrate this project's state management from " +
            "one library/pattern to another (e.g. Redux to Zustand or Context, Vuex to Pinia, MobX to signals).\n\n" +
            "First, map out the current state shape and every place it's read from or written to — this " +
            "determines the real scope, which is usually much wider than just the store definition itself.\n\n" +
            "Then produce a migration plan that:\n" +
            "1. Preserves the exact same data flow and component behavior — this is a refactor of HOW state is " +
            "managed, not a change to WHAT the app does.\n" +
            "2. Migrates incrementally where the two systems can coexist temporarily, rather than requiring one " +
            "giant atomic cutover, if the target library allows it.\n" +
            "3. Flags any place that relied on library-specific behavior (middleware, selectors, computed/derived " +
            "state) that needs an explicit equivalent in the new system, not just a mechanical rename.\n\n" +
            "After migrating, run the test suite and do a quick manual check of core user flows before " +
            "considering it done."
    },
    {
        id: 'callback-async-modernizer',
        label: 'Callback→Async/Await Modernizer',
        description: 'Convert legacy callback-based code to promises/async-await, preserving exact execution order and error handling',
        group: 'migration',
        tier: 'paid',
        prompt:
            "Act as a code modernizer. Find callback-based asynchronous code in this project (or the specific " +
            "files/area I point you at) and convert it to promises/async-await.\n\n" +
            "This must be behavior-preserving, not just a syntax change:\n" +
            "1. Preserve the exact same execution order, including any intentional sequencing or parallelism " +
            "(don't accidentally serialize calls that were meant to run concurrently, or vice versa).\n" +
            "2. Preserve error handling semantics — a callback's error-first argument or an .catch() handler must " +
            "map to equivalent try/catch behavior, not silently swallow errors that used to be handled.\n" +
            "3. Watch for callback hell patterns hiding subtle bugs (a callback that fires more than once, a " +
            "missing error check) — flag these rather than silently carrying the bug forward into the new syntax.\n\n" +
            "After converting, run the test suite and fix anything that fails before finishing."
    },
    {
        id: 'css-framework-migrator',
        label: 'CSS Framework Migrator',
        description: 'Migrate between CSS approaches (Bootstrap→Tailwind, styled-components→CSS Modules, etc.)',
        group: 'migration',
        tier: 'paid',
        prompt:
            "Act as a CSS migration specialist. Help migrate this project's styling approach from one system to " +
            "another (e.g. Bootstrap to Tailwind, styled-components to CSS Modules, SCSS to vanilla CSS).\n\n" +
            "1. First inventory the actual visual patterns in use (spacing scale, color palette, breakpoints, " +
            "component-level style overrides) rather than migrating class-by-class blind.\n" +
            "2. Migrate incrementally, component by component, and after each one, describe what visual " +
            "regression risk exists so it can be checked (ideally take/compare screenshots if tooling allows, " +
            "otherwise flag for manual visual review).\n" +
            "3. Preserve responsive behavior exactly — breakpoints and conditional styles are the most common " +
            "place this kind of migration silently breaks something.\n" +
            "4. Remove the old system's dependency and any now-dead style files once the migration is complete, " +
            "not before.\n\n" +
            "Flag anything that can't be mechanically translated (complex animations, third-party component " +
            "overrides) for manual review rather than guessing at an equivalent."
    },

    // ── Review & Quality ──────────────────────────────────────────────────────
    {
        id: 'senior-code-reviewer',
        label: 'Senior Code Reviewer',
        description: 'Reviews a diff/PR the way a thorough senior engineer would — naming, error handling, edge cases, missed abstractions',
        group: 'review',
        tier: 'paid',
        prompt:
            "Act as a senior engineer doing a thorough code review of the current diff (or the specific files/PR " +
            "I point you at) — the kind of review that catches real problems, not a rubber stamp.\n\n" +
            "Look for:\n" +
            "- Naming that misleads about what something actually does.\n" +
            "- Missing or wrong error handling — errors swallowed silently, or handled at the wrong layer.\n" +
            "- Edge cases the code doesn't visibly consider (empty input, null/undefined, concurrent access, " +
            "the boundary values of any range checks).\n" +
            "- Missed abstractions — duplicated logic that should be shared, or an abstraction forced where three " +
            "similar lines would've been clearer.\n" +
            "- Anything that will confuse the next person to read this code, even if it technically works.\n\n" +
            "For every finding, cite the exact file and line, explain why it matters concretely (not just " +
            "'this is bad practice'), and suggest a specific fix. Skip purely stylistic nitpicks that a linter " +
            "would already catch — focus on things that actually affect correctness or maintainability."
    },
    {
        id: 'db-migration-safety-checker',
        label: 'Database Migration Safety Checker',
        description: 'Reviews schema changes for locking behavior, backward compatibility, and safety under concurrent writes',
        group: 'review',
        tier: 'paid',
        prompt:
            "Act as a database migration safety reviewer. Review the schema migration(s) I point you at (or any " +
            "pending/recent ones in this project) for production safety.\n\n" +
            "Check specifically for:\n" +
            "1. Locking behavior — does this migration take a lock that would block reads/writes on a large " +
            "table for the duration, and is that acceptable for this project's traffic patterns?\n" +
            "2. Backward compatibility — will the OLD version of the application code still work correctly " +
            "against the NEW schema during a rolling deploy, or does this require a hard cutover?\n" +
            "3. Safety under concurrent writes — could this migration race with in-flight application traffic " +
            "(e.g. adding a NOT NULL column without a default, dropping a column still being written to)?\n" +
            "4. Whether the migration is reversible, and what the rollback plan actually is if something goes " +
            "wrong mid-deploy.\n\n" +
            "For every issue found, cite the exact migration file/line and explain the concrete failure scenario " +
            "— what breaks, under what conditions — not just 'this could be risky.'"
    },
    {
        id: 'performance-profiler',
        label: 'Performance Profiler',
        description: 'Finds N+1 queries, unnecessary re-renders, and inefficient loops, with concrete fixes',
        group: 'review',
        tier: 'paid',
        prompt:
            "Act as a performance reviewer. Analyze this codebase (or the specific files/area I point you at) " +
            "for real, concrete performance problems: N+1 database queries, unnecessary re-renders, inefficient " +
            "loops (especially nested loops over large collections), and repeated expensive work that could be " +
            "cached or memoized.\n\n" +
            "For every finding:\n" +
            "- Cite the exact file and line.\n" +
            "- Explain the actual cost — e.g. 'this issues one query per item in the list, so N items means N+1 " +
            "queries' — not just 'this could be slow.'\n" +
            "- Estimate realistic impact given how this code is actually invoked (a loop over 5 items in an " +
            "admin panel matters less than one in a hot request path).\n" +
            "- Suggest a specific fix (batching, memoization, an index, restructuring the loop).\n\n" +
            "Prioritize findings that affect hot paths or user-facing latency over ones in rarely-run code. Don't " +
            "flag micro-optimizations with no measurable real-world impact."
    },
    {
        id: 'error-handling-auditor',
        label: 'Error Handling Auditor',
        description: 'Finds silently swallowed errors and inconsistent try/catch patterns across the codebase',
        group: 'review',
        tier: 'paid',
        prompt:
            "Act as an error-handling auditor. Search this codebase for error handling that's missing, " +
            "inconsistent, or actively hiding problems:\n\n" +
            "- Empty catch blocks or catches that swallow the error without logging, re-throwing, or handling it.\n" +
            "- Promises with no .catch() and no surrounding try/catch (unhandled rejections).\n" +
            "- Inconsistent patterns across the codebase — some places handle a given failure mode, others " +
            "don't, for no apparent reason.\n" +
            "- Errors caught too broadly (catching Error when only a specific failure should be handled, masking " +
            "unrelated bugs as if they were the expected failure case).\n\n" +
            "For every finding, cite the exact file and line, describe the concrete consequence (a silent " +
            "failure a user or on-call engineer would have no way to diagnose), and suggest a specific fix that " +
            "matches this codebase's existing error-handling conventions where one exists."
    },
    {
        id: 'dead-code-finder',
        label: 'Dead Code Finder',
        description: 'Locates and safely removes unused exports/files using real cross-file analysis, not just a linter\'s local view',
        group: 'review',
        tier: 'paid',
        prompt:
            "Act as a dead code auditor. Find unused exports, functions, and files in this project using real " +
            "cross-file analysis — search for actual usages across the whole codebase, not just within a single " +
            "file, so you catch things a linter's local view would miss.\n\n" +
            "For each candidate:\n" +
            "1. Confirm it's genuinely unreferenced anywhere in the codebase (including dynamic imports, string-" +
            "based references, and framework conventions like file-based routing where 'unused' by grep doesn't " +
            "mean actually unused).\n" +
            "2. Check whether it's part of a public API (an exported package entry point) rather than truly dead " +
            "— those need to stay even if nothing in this repo calls them.\n" +
            "3. Only after confirming, remove it — don't guess.\n\n" +
            "After removing anything, run the test suite and typecheck (if applicable) to confirm nothing broke, " +
            "and report exactly what was removed and why each item was confirmed safe to delete."
    },

    // ── Compliance & Accessibility ───────────────────────────────────────────
    {
        id: 'accessibility-auditor',
        label: 'Accessibility Auditor',
        description: 'WCAG-focused accessibility review that cites concrete violations with fixes',
        group: 'compliance',
        tier: 'paid',
        prompt:
            "Act as an accessibility auditor. Review this codebase's UI code (or the specific files/components " +
            "I point you at) against WCAG 2.1 AA guidelines.\n\n" +
            "Check specifically for:\n" +
            "- Missing or wrong semantic HTML (divs used where buttons/links belong, missing landmark regions).\n" +
            "- Missing alt text, ARIA labels, or ARIA roles where needed — and ARIA misuse where it's present " +
            "but wrong.\n" +
            "- Keyboard navigability — can everything interactive actually be reached and operated without a " +
            "mouse, with a visible focus state?\n" +
            "- Color contrast issues, where determinable from the code (hardcoded colors, theme tokens).\n" +
            "- Form inputs missing associated labels or error messaging that isn't announced to screen readers.\n\n" +
            "For every finding, cite the exact file/component, name the specific WCAG success criterion it " +
            "violates, and suggest a concrete fix. Don't flag purely subjective UX preferences dressed up as " +
            "accessibility issues."
    },
    {
        id: 'license-compliance-auditor',
        label: 'License Compliance Auditor',
        description: 'Flags GPL-contamination risk and license incompatibilities across dependencies',
        group: 'compliance',
        tier: 'paid',
        prompt:
            "Act as a license compliance auditor. Review this project's dependencies for license compatibility " +
            "issues.\n\n" +
            "1. Identify each dependency's license (check package metadata/LICENSE files rather than assuming).\n" +
            "2. Flag copyleft licenses (GPL, AGPL, LGPL) that could impose obligations on this project depending " +
            "on how they're used (statically linked vs. a separate process, distributed vs. internal-only) — be " +
            "explicit about the actual mechanism of contamination risk, not just 'GPL is scary.'\n" +
            "3. Flag any licenses that are genuinely incompatible with each other if this project redistributes " +
            "the combined result.\n" +
            "4. Note anything with no clear license at all — the actual highest-risk case, since 'no license' " +
            "usually defaults to full copyright reservation, not permissive use.\n\n" +
            "I'm not a lawyer and neither are you — flag real risk clearly and specifically, but frame this as " +
            "'here's what to have a lawyer look at' for anything genuinely ambiguous, not as final legal advice."
    },
    {
        id: 'pii-data-privacy-auditor',
        label: 'PII/Data Privacy Auditor',
        description: 'Flags where personal data might be logged or stored insecurely — a compliance lens, distinct from Security Auditor\'s exploit lens',
        group: 'compliance',
        tier: 'paid',
        prompt:
            "Act as a data privacy auditor. Review this codebase for how it handles personally identifiable " +
            "information (PII) — names, emails, addresses, phone numbers, government IDs, payment details, " +
            "health data, or anything else that identifies a real person.\n\n" +
            "Check specifically for:\n" +
            "- PII written to logs, error messages, or analytics/telemetry events that shouldn't contain it.\n" +
            "- PII stored without encryption at rest where the data's sensitivity would call for it.\n" +
            "- PII sent to third-party services (analytics, error tracking, AI APIs) without clear justification " +
            "or user consent.\n" +
            "- Data retention with no apparent expiry — PII kept indefinitely with no deletion path.\n\n" +
            "This is a compliance/data-handling lens, distinct from a security exploit review — the concern here " +
            "is 'should this data exist here at all,' not 'can an attacker steal it.' For every finding, cite " +
            "the exact file/line and describe the concrete data exposure, not a theoretical one."
    },
    {
        id: 'i18n-readiness-auditor',
        label: 'i18n Readiness Auditor',
        description: 'Finds hardcoded strings that should be internationalized and locale-unsafe date/number formatting',
        group: 'compliance',
        tier: 'paid',
        prompt:
            "Act as an internationalization (i18n) readiness auditor. Review this codebase's UI code for what " +
            "would break or need work before it could ship in a non-English locale.\n\n" +
            "Check specifically for:\n" +
            "- Hardcoded user-facing strings that aren't going through a translation/i18n system, if one exists " +
            "in this project (or note that none exists, if that's the case).\n" +
            "- Locale-unsafe date, time, number, and currency formatting (hardcoded formats instead of using the " +
            "platform's locale-aware formatting APIs).\n" +
            "- Layout assumptions that break for longer translated strings or right-to-left languages (fixed-" +
            "width containers, text truncation that would cut off translated text mid-word).\n" +
            "- String concatenation that builds sentences from fragments — a pattern that breaks for languages " +
            "with different word order than English.\n\n" +
            "Cite the exact file and line for each finding, and prioritize the highest-traffic user-facing " +
            "screens over rarely-seen admin/internal ones."
    },

    // ── Onboarding & Docs ─────────────────────────────────────────────────────
    {
        id: 'new-codebase-onboarding-guide',
        label: 'New Codebase Onboarding Guide',
        description: 'Generates the practical "how do I get set up, where do I make my first change" doc a new hire actually needs',
        group: 'onboarding',
        tier: 'paid',
        prompt:
            "Act as an onboarding guide writer. Produce the practical, get-productive-fast document a brand new " +
            "engineer joining this project would actually want on day one — distinct from an architecture " +
            "overview (that's what Codebase Cartographer is for); this is about getting hands dirty quickly.\n\n" +
            "Produce:\n" +
            "1. Exact setup steps — what to install, what commands to run, in what order, to get this running " +
            "locally. Verify these actually work by trying them, don't just describe what looks right from the " +
            "README.\n" +
            "2. Where to make a first small change — a low-risk, well-contained part of the codebase a newcomer " +
            "could safely touch to learn the codebase's conventions hands-on.\n" +
            "3. The project's real conventions a newcomer wouldn't guess (branch naming, commit message style, " +
            "how tests are run, where config/secrets come from).\n" +
            "4. Common early mistakes or gotchas specific to this codebase, if any are evident from its " +
            "structure or comments.\n\n" +
            "Write it as a real onboarding doc a person would read top to bottom on their first day, not a " +
            "reference dump."
    },
    {
        id: 'api-documentation-generator',
        label: 'API Documentation Generator',
        description: 'Reads route handlers/endpoints and produces OpenAPI-style docs from what the code actually does',
        group: 'onboarding',
        tier: 'paid',
        prompt:
            "Act as an API documentation generator. Read this project's route handlers/API endpoints directly " +
            "and produce documentation describing what they actually do — not what a stale existing doc claims, " +
            "if one exists and disagrees with the code.\n\n" +
            "For each endpoint, document:\n" +
            "- Method, path, and purpose.\n" +
            "- Request parameters/body shape, including which are required vs. optional, inferred from actual " +
            "validation logic in the code, not guessed.\n" +
            "- Response shape for success and for realistic error cases (auth failure, validation failure, not " +
            "found) — check what the code actually returns for each.\n" +
            "- Authentication/authorization requirements, if any.\n\n" +
            "Format as OpenAPI-style documentation where practical. If an existing docs file/comment contradicts " +
            "what the code actually does, flag the discrepancy explicitly rather than silently trusting either " +
            "source."
    },
    {
        id: 'changelog-generator',
        label: 'Changelog Generator',
        description: 'Reads git history since the last release and drafts a changelog matching the project\'s own established style',
        group: 'onboarding',
        tier: 'paid',
        prompt:
            "Act as a changelog generator. Read this project's git history since the last release (check the " +
            "most recent tag, or ask me for the reference point if none is obvious) and draft a changelog entry.\n\n" +
            "First, read the existing CHANGELOG (if one exists) to learn this project's actual established " +
            "style — heading format, how entries are grouped (Added/Fixed/Changed, or a flat list), the level " +
            "of detail typically used — and match it rather than imposing a generic template.\n\n" +
            "Then:\n" +
            "1. Group commits into meaningful entries — collapse a feature's many small commits into one clear " +
            "line, not a raw commit-log dump.\n" +
            "2. Write from the user's perspective (what changed for them), not the implementation's perspective.\n" +
            "3. Flag anything that looks like a breaking change prominently.\n" +
            "4. Skip purely internal changes (refactors, test-only commits) unless this project's existing " +
            "changelog style includes those too."
    },
    {
        id: 'pr-description-writer',
        label: 'PR Description Writer',
        description: 'Reads a diff and writes a proper summary + test plan, optionally incorporating a linked issue/ticket',
        group: 'onboarding',
        tier: 'paid',
        prompt:
            "Act as a PR description writer. Read the current diff (uncommitted changes, or the specific " +
            "branch/commit range I point you at) and write a clear pull request description.\n\n" +
            "Include:\n" +
            "1. A concise summary of WHAT changed and WHY — the why matters more than the what, since the diff " +
            "itself already shows what changed.\n" +
            "2. A test plan — what was tested, and what a reviewer should check to verify this works.\n" +
            "3. Anything a reviewer should pay special attention to (a risky change, a deliberate tradeoff, " +
            "something intentionally left out of scope).\n\n" +
            "Optional: if I provide linked issue/ticket text (pasted from Jira, Linear, GitHub Issues, etc.), " +
            "incorporate its context and acceptance criteria into the description, and add the appropriate " +
            "closing reference (e.g. 'Closes #123') so the PR links back to it — rather than writing the PR " +
            "description in isolation from why the work was requested.\n\n" +
            "Keep it factual and specific to this diff — don't pad with generic boilerplate a reviewer would " +
            "skip past."
    },

    // ── Infrastructure & DevOps ───────────────────────────────────────────────
    {
        id: 'cicd-pipeline-debugger',
        label: 'CI/CD Pipeline Debugger',
        description: 'Diagnoses failing pipeline configs by reading the actual CI YAML and recent run output',
        group: 'infra',
        tier: 'paid',
        prompt:
            "Act as a CI/CD pipeline debugger. Diagnose why this project's CI/CD pipeline is failing (or " +
            "review the config for problems if nothing's actively broken).\n\n" +
            "1. Read the actual pipeline config file(s) directly (GitHub Actions, GitLab CI, CircleCI, Jenkins, " +
            "whatever this project uses) rather than guessing at what a typical setup looks like.\n" +
            "2. If there's a specific failure, use run_command to reproduce the failing step locally where " +
            "possible, so the diagnosis is based on the real error, not speculation about what might cause a " +
            "failure with that name.\n" +
            "3. Check for common pipeline-specific failure modes: caching issues (stale cache causing wrong " +
            "dependency versions), environment differences between local and CI, missing secrets/env vars, and " +
            "flaky steps versus genuinely broken ones.\n" +
            "4. Propose a specific fix, and if you can, verify it would actually resolve the failure rather than " +
            "just plausibly might.\n\n" +
            "Cite the exact file/line in the pipeline config for every finding."
    },
    {
        id: 'dockerfile-optimizer',
        label: 'Dockerfile Optimizer',
        description: 'Reviews Dockerfiles for image bloat, running-as-root, and missed multi-stage build opportunities',
        group: 'infra',
        tier: 'paid',
        prompt:
            "Act as a Dockerfile optimizer. Review this project's Dockerfile(s) for real, concrete " +
            "improvements.\n\n" +
            "Check specifically for:\n" +
            "1. Image bloat — unnecessary layers, build tools/dev dependencies left in the final image that " +
            "should be excluded via a multi-stage build.\n" +
            "2. Missed multi-stage build opportunities — separating the build environment from the runtime " +
            "environment where it isn't already done.\n" +
            "3. Running as root when a non-root user would work just as well — a real security hardening step, " +
            "not just best-practice theater.\n" +
            "4. Layer caching inefficiency — commands ordered so that a change to source code invalidates the " +
            "cache for slow steps (dependency installs) that didn't need to re-run.\n" +
            "5. Missing or overly broad .dockerignore causing unnecessary build context.\n\n" +
            "For every finding, cite the exact line and estimate the real impact (image size reduction, build " +
            "time, actual security improvement) rather than flagging changes with no meaningful effect."
    },
    {
        id: 'iac-reviewer',
        label: 'Infrastructure-as-Code Reviewer',
        description: 'Checks Terraform/CloudFormation/Pulumi configs for common misconfigurations (open security groups, unencrypted storage)',
        group: 'infra',
        tier: 'paid',
        prompt:
            "Act as an Infrastructure-as-Code reviewer. Review this project's IaC configs (Terraform, " +
            "CloudFormation, Pulumi, or whatever this project uses) for common, concrete misconfigurations.\n\n" +
            "Check specifically for:\n" +
            "- Security groups/firewall rules open wider than necessary (0.0.0.0/0 on ports that shouldn't be " +
            "publicly reachable).\n" +
            "- Unencrypted storage (databases, object storage, volumes) where encryption at rest should be the " +
            "default.\n" +
            "- Overly broad IAM permissions/roles — wildcard actions or resources where a scoped policy would " +
            "work just as well.\n" +
            "- Hardcoded secrets or credentials in the IaC files themselves, instead of a secrets manager " +
            "reference.\n" +
            "- Missing resource tagging/naming conventions if this project has an established pattern elsewhere " +
            "that these files don't follow.\n\n" +
            "For every finding, cite the exact file/resource block, explain the concrete exposure (what an " +
            "attacker or a mistake could actually do), and suggest a specific fix."
    },

    // ── Team & Process ────────────────────────────────────────────────────────
    {
        id: 'code-ownership-mapper',
        label: 'Code Ownership Mapper',
        description: 'Uses git history to show who has real context on which parts of the codebase, useful for review routing',
        group: 'team',
        tier: 'paid',
        prompt:
            "Act as a code ownership mapper. Use git history (via run_command with git log/git blame, not " +
            "guessing) to determine who has real, recent context on different parts of this codebase.\n\n" +
            "Produce:\n" +
            "1. A breakdown by major module/directory of who has committed most substantially and most " +
            "recently — recency matters more than raw commit count, since someone who wrote a module two years " +
            "ago and never touched it since has less current context than a recent frequent contributor.\n" +
            "2. Areas with a single dominant contributor — a bus-factor risk worth flagging, not just a fact.\n" +
            "3. Areas that look genuinely unowned — no clear recent contributor, which is useful to know before " +
            "assigning review or on-call responsibility there.\n\n" +
            "Frame this as useful for routing code review and on-call context, not as a performance evaluation " +
            "— commit count is a proxy for context, not a measure of someone's value or effort."
    },
    {
        id: 'technical-debt-prioritizer',
        label: 'Technical Debt Prioritizer',
        description: 'A focused, prioritized backlog of technical debt with rough effort/impact per item',
        group: 'team',
        tier: 'paid',
        prompt:
            "Act as a technical debt prioritizer. Survey this codebase for real technical debt — not stylistic " +
            "nitpicks, but things that genuinely slow the team down or create real risk (fragile code that " +
            "breaks often, missing tests around critical logic, architectural patterns that make simple changes " +
            "unexpectedly hard, outdated approaches that make onboarding harder than it should be).\n\n" +
            "For each item found:\n" +
            "1. Describe the concrete cost of leaving it as-is — what it actually makes harder or riskier, with " +
            "a specific example if possible.\n" +
            "2. Give a rough effort estimate (small/medium/large) based on the real scope in this codebase, not " +
            "a generic guess.\n" +
            "3. Give a rough impact estimate — how much this would actually help if fixed.\n\n" +
            "Produce a prioritized list (impact vs. effort, highest-value-per-effort first), not just a flat " +
            "dump of everything imperfect. Skip anything that's a matter of taste rather than a real cost."
    },
    {
        id: 'env-variable-auditor',
        label: 'Environment Variable Auditor',
        description: 'Finds env vars referenced in code but missing from .env.example, or vice versa',
        group: 'team',
        tier: 'paid',
        prompt:
            "Act as an environment variable auditor. Cross-reference every environment variable actually " +
            "referenced in this codebase's code against what's documented in .env.example (or equivalent — " +
            "check what convention this project actually uses).\n\n" +
            "Report:\n" +
            "1. Variables read in code (process.env.X, os.environ, equivalent) but missing from the example/" +
            "documented file — a real onboarding trap, since a new setup would silently misbehave rather than " +
            "fail clearly.\n" +
            "2. Variables listed in the example file but never actually referenced anywhere in the code — likely " +
            "stale, worth removing or flagging as unused.\n" +
            "3. Variables with inconsistent naming or an unclear purpose (no comment, ambiguous name) that would " +
            "confuse someone setting the project up for the first time.\n\n" +
            "Cite the exact file/line for both the code reference and the example-file entry (or absence of " +
            "one) for every finding, so both sides are easy to verify."
    },

    // ── Framework & Language Specialists ─────────────────────────────────────
    {
        id: 'react-component-auditor',
        label: 'React Component Auditor',
        description: 'Hooks misuse, missing dependency arrays, unnecessary re-renders, prop drilling',
        group: 'specialists',
        tier: 'paid',
        prompt:
            "Act as a React specialist doing a component-level audit. Review this project's React components " +
            "(or the specific ones I point you at) for React-specific problems, distinct from generic " +
            "performance issues:\n\n" +
            "- Hooks misuse: conditional hook calls, hooks called in loops, violations of the rules of hooks.\n" +
            "- Missing or incorrect dependency arrays in useEffect/useMemo/useCallback — both missing " +
            "dependencies (stale closures) and unnecessary ones (defeating the memoization).\n" +
            "- Unnecessary re-renders — components re-rendering due to new object/array/function references " +
            "created on every render where memoization would help, or state lifted higher than it needs to be.\n" +
            "- Prop drilling that's gotten deep enough that Context or a state library would genuinely help, " +
            "versus prop passing that's still reasonable.\n\n" +
            "For every finding, cite the exact file/component and line, explain the concrete symptom (what a " +
            "user or developer would actually notice), and suggest a specific fix."
    },
    {
        id: 'sql-query-optimizer',
        label: 'SQL Query Optimizer',
        description: 'Raw SQL/ORM queries checked for missing indexes, N+1 patterns, and inefficient joins',
        group: 'specialists',
        tier: 'paid',
        prompt:
            "Act as a SQL query optimizer. Review this project's database queries — raw SQL and ORM-generated " +
            "queries alike — for real performance problems.\n\n" +
            "Check specifically for:\n" +
            "- Missing indexes on columns used in WHERE/JOIN/ORDER BY clauses for queries that run against " +
            "large tables.\n" +
            "- N+1 query patterns — a loop issuing one query per iteration where a single batched query or a " +
            "join/prefetch would work.\n" +
            "- Inefficient joins — joining more tables/rows than the query actually needs, or joining before " +
            "filtering when filtering first would reduce the join's working set.\n" +
            "- SELECT * where only specific columns are actually used downstream.\n\n" +
            "For every finding, cite the exact file/line, and where possible check the actual schema (via " +
            "run_command or reading migration files) to confirm whether an index already exists rather than " +
            "assuming. Suggest a specific fix — an index to add, a query restructure, or a batching approach."
    },
    {
        id: 'python-type-hint-adder',
        label: 'Python Type Hint Adder',
        description: 'Adds/improves type hints across an untyped codebase, matching mypy/pyright conventions',
        group: 'specialists',
        tier: 'paid',
        prompt:
            "Act as a Python typing specialist. Add or improve type hints across this codebase (or the specific " +
            "files/modules I point you at).\n\n" +
            "1. First check whether this project already uses mypy, pyright, or another type checker, and read " +
            "its config — match the strictness level and conventions already established rather than imposing " +
            "your own defaults.\n" +
            "2. Add hints incrementally, function by function — parameter types, return types, and class " +
            "attribute types — inferring the real type from how each value is actually used, not just labeling " +
            "everything Any.\n" +
            "3. Use precise types where the code supports it (specific types, Union/Optional where genuinely " +
            "needed) rather than over-broad ones that don't add real safety.\n" +
            "4. Flag any place where adding an accurate type hint reveals a real latent bug (a function that " +
            "can actually return None but callers don't check for it).\n\n" +
            "After adding hints, run the project's type checker (if configured) and fix any errors it surfaces " +
            "before finishing."
    },
    {
        id: 'graphql-schema-reviewer',
        label: 'GraphQL Schema Reviewer',
        description: 'N+1 resolver patterns, missing pagination, and breaking changes vs. a previous schema version',
        group: 'specialists',
        tier: 'paid',
        prompt:
            "Act as a GraphQL specialist reviewing this project's schema and resolvers.\n\n" +
            "Check specifically for:\n" +
            "1. N+1 resolver patterns — a resolver that issues a separate data-fetch per item in a list instead " +
            "of batching (e.g. via DataLoader or an equivalent) — this is the single most common real-world " +
            "GraphQL performance problem.\n" +
            "2. Missing pagination on fields that return lists that could grow unbounded — a real risk both for " +
            "performance and for a client accidentally requesting an enormous response.\n" +
            "3. If a previous schema version is available (via git history), breaking changes to the current " +
            "schema — removed fields/types, changed field types, or newly-required arguments that would break " +
            "existing client queries.\n" +
            "4. Overly permissive or missing field-level authorization where sensitive data is exposed.\n\n" +
            "For every finding, cite the exact schema/resolver file and line, and explain the concrete impact " +
            "on a real client querying this API."
    },

    // ── Release & Ops ─────────────────────────────────────────────────────────
    {
        id: 'changelog-aware-release-assistant',
        label: 'Changelog-Aware Release Assistant',
        description: 'Bumps version strings consistently across a project/monorepo and drafts release notes matching established style',
        group: 'release',
        tier: 'paid',
        prompt:
            "Act as a release assistant. Prepare this project for a new release.\n\n" +
            "1. Find every place a version string needs to be bumped consistently (package.json, any " +
            "sub-packages in a monorepo, version constants in code, Dockerfile labels) — search the whole " +
            "project rather than assuming there's only one place, since a missed one is a common real release " +
            "bug.\n" +
            "2. Read the project's git history since the last release/tag and draft release notes matching the " +
            "existing CHANGELOG's established style (same approach as the standalone Changelog Generator, " +
            "applied here as part of the full release step).\n" +
            "3. Confirm the version bump matches semver expectations given what actually changed (a breaking " +
            "change needs a major bump, not a patch, regardless of what I initially suggest — flag it if I ask " +
            "for the wrong bump type).\n\n" +
            "After making the changes, run the test suite to confirm the release candidate is actually healthy " +
            "before considering it done."
    },
    {
        id: 'feature-flag-cleanup',
        label: 'Feature Flag Cleanup',
        description: 'Finds stale/permanently-on flags and removes the dead branches around them',
        group: 'release',
        tier: 'paid',
        prompt:
            "Act as a feature flag cleanup specialist. Find stale feature flags in this codebase — flags that " +
            "are permanently on, permanently off, or otherwise no longer serving a real purpose — and clean " +
            "them up.\n\n" +
            "For each flag found:\n" +
            "1. Determine its current state if possible (check config/constants for a hardcoded value, or ask " +
            "me if it's controlled by an external system I'd need to check).\n" +
            "2. If it's effectively permanent, remove the flag check entirely and keep only the branch that " +
            "actually runs — collapsing the conditional, not just leaving dead code behind it.\n" +
            "3. Remove the now-unreachable branch and any code that only existed to support it.\n" +
            "4. Flag any flag whose state is genuinely unclear rather than guessing — a wrongly-removed flag " +
            "that's actually still load-bearing is a real production risk.\n\n" +
            "After cleanup, run the test suite and remove any now-dead tests that only existed to cover the " +
            "removed branch."
    },
    {
        id: 'breaking-change-detector',
        label: 'Breaking Change Detector',
        description: 'Diffs the current branch against main/a previous tag, flags changes to exported functions/public APIs',
        group: 'release',
        tier: 'paid',
        prompt:
            "Act as a breaking change detector. Compare the current branch against main (or a specific previous " +
            "tag/commit I point you at) and identify changes that would break downstream consumers of this " +
            "project's public API/exports.\n\n" +
            "Check specifically for:\n" +
            "1. Removed or renamed exported functions, classes, types, or constants.\n" +
            "2. Changed function signatures — removed/reordered parameters, changed parameter types, changed " +
            "return types — for anything exported.\n" +
            "3. Changed behavior of an exported function that keeps the same signature but now does something " +
            "meaningfully different (harder to catch than a signature change, but just as breaking).\n" +
            "4. Changes to any documented public API contract (REST/GraphQL endpoints, CLI flags) even if " +
            "internal implementation details also changed.\n\n" +
            "For every breaking change found, cite the exact file/line, explain concretely what a consumer's " +
            "code would need to change to keep working, and note whether it warrants a major version bump."
    },

    // ── Testing Deep-Dives (companions to the free Multi-File Test Engineer) ──
    {
        id: 'flaky-test-diagnostician',
        label: 'Flaky Test Diagnostician',
        description: 'Investigates one specific failing/flaky test and either fixes it or explains the real root cause',
        group: 'testing',
        tier: 'paid',
        prompt:
            "Act as a flaky test diagnostician. I'll point you at one specific failing or intermittently-" +
            "failing test — investigate it thoroughly and either fix it or explain the real root cause.\n\n" +
            "1. Run the test (ideally several times, via run_command) to confirm the actual failure mode — " +
            "does it fail consistently, or only sometimes? What's the actual error each time?\n" +
            "2. Read the test and the code it exercises to understand what could cause non-determinism: shared " +
            "state between tests, timing/race conditions, reliance on real time (Date.now(), timers) without " +
            "mocking, test execution order dependence, or an actual bug in the code under test rather than the " +
            "test itself.\n" +
            "3. If you can reproduce and root-cause it, fix it. If it's genuinely hard to reproduce, explain " +
            "precisely what evidence points to which hypothesis, rather than guessing at a fix for a cause " +
            "that's not actually confirmed.\n\n" +
            "After any fix, run the test repeatedly to build real confidence it's actually resolved, not just " +
            "passing once by chance."
    },
    {
        id: 'test-coverage-gap-report',
        label: 'Test Coverage Gap Report',
        description: 'Runs the project\'s own coverage tool, then prioritizes which uncovered lines actually matter',
        group: 'testing',
        tier: 'paid',
        prompt:
            "Act as a test coverage analyst. Run this project's own coverage tooling (check package.json/CI " +
            "config for what's already set up — don't introduce a new one) and produce a prioritized gap report, " +
            "not just a raw percentage.\n\n" +
            "For the uncovered code found:\n" +
            "1. Prioritize by what actually matters — business logic with real consequences (money, auth, data " +
            "loss) ranks far above uncovered boilerplate, generated code, or trivial getters.\n" +
            "2. For each high-priority gap, explain concretely what could go wrong if a bug were introduced " +
            "there and nothing would catch it.\n" +
            "3. Note any coverage that's technically present but weak (a line executed by a test that doesn't " +
            "actually assert on the meaningful behavior) — coverage percentage alone doesn't catch this.\n\n" +
            "Present this as a prioritized list a team could actually act on, not a wall of uncovered line " +
            "numbers. If asked, write tests for the highest-priority gaps first."
    },

    // ── Data Analysis ────────────────────────────────────────────────────────
    {
        id: 'exploratory-data-analysis',
        label: 'Exploratory Data Analysis',
        description: 'Profiles a dataset for data-quality issues, distributions, and correlations that actually matter before you build on it',
        group: 'data-analysis',
        tier: 'paid',
        prompt:
            "Act as a data analyst doing exploratory data analysis on the dataset I point you at (a CSV/Parquet " +
            "file, a DataFrame already loaded in a notebook or script, or a database table). Produce a " +
            "prioritized profile, not a wall of summary statistics.\n\n" +
            "Check specifically for:\n" +
            "1. Shape and schema — row/column count, dtypes per column, and whether any column's dtype looks " +
            "wrong for its content (e.g. a numeric ID stored as float, a date stored as a string).\n" +
            "2. Missing values — which columns, what percentage, and whether the pattern looks random or " +
            "structural (e.g. always missing together, or correlated with another column's value).\n" +
            "3. Duplicate rows or duplicate keys where the column names imply a unique identifier.\n" +
            "4. Outliers in numeric columns — state the method used (IQR or z-score) and cite the actual row " +
            "indices and values found, not just 'there are some outliers'.\n" +
            "5. Distribution shape per numeric column — flag meaningful skew, unexpected clustering at a single " +
            "value (often a disguised null, e.g. 0 or -1), or a range that doesn't match what the column name " +
            "implies.\n" +
            "6. Correlations between numeric columns — report only the ones strong enough to matter for " +
            "analysis or modelling, not the full matrix.\n" +
            "7. Categorical columns — cardinality, class imbalance, and inconsistent value formatting (e.g. " +
            "'NSW' vs 'New South Wales' vs 'nsw' meaning the same thing).\n" +
            "8. If there's a date/time column: gaps in the expected frequency, and any obvious seasonality worth " +
            "noting before someone builds a time-series model on it.\n\n" +
            "For every finding, cite the exact column name and specific row/value examples — not a generic " +
            "statement. Prioritize what would actually break or mislead an analysis built on this data over " +
            "minor cosmetic issues. Close with concrete next steps (specific cleaning operations, columns " +
            "needing transformation, or a note on what to watch for in a train/test split) rather than stopping " +
            "at description."
    }
];
