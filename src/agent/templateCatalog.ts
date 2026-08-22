// src/agent/templateCatalog.ts — fetches the paid template library catalog
// from the backend and merges it with the free, bundled PROMPT_TEMPLATES.
//
// Caching mirrors src/license/validator.ts's getLicenseStatus() shape
// (in-memory var + globalState entry, short TTL, offline-fallback-if-ever-
// fetched) but uses its own storage — never validator.ts's _memCache/
// licenseCache, which are keyed to freebird.licenseKey specifically and would
// cross-contaminate cache invalidation between the two lifecycles.

import * as vscode from 'vscode';
import { API_BASE } from '../license/validator';
import { PROMPT_TEMPLATES, PromptTemplate } from './promptTemplates';

export interface CatalogEntry {
    id: string;
    label: string;
    description: string;
    group?: string;
    locked: boolean;
    prompt?: string; // present only when unlocked
}

const CACHE_TTL_MS = 60 * 60 * 1000;          // 1 hour, matches validator.ts
const OFFLINE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days offline grace

// Lightweight metadata-only manifest for the offline/error fallback — no
// prompt text, so it's safe to bundle client-side. Keeps paid templates
// visible-but-locked in the QuickPick even when the catalog fetch fails,
// rather than hiding them (a visibility fail-open, distinct from license
// validation's fail-closed philosophy — only the prompt text stays gated).
// Mirrors backend/lib/templateCatalog.js's id/label/description/group for
// every entry — update both together when the catalog changes; a mismatch
// here only affects what's shown while offline, never entitlement itself.
const OFFLINE_MANIFEST: Omit<CatalogEntry, 'prompt'>[] = [
    { id: 'framework-migration-planner', label: 'Framework Migration Planner', description: 'Plan a framework/language migration (JS→TS, class→hooks, CommonJS→ESM, REST→GraphQL) with a concrete, incremental path', group: 'migration', locked: true },
    { id: 'dependency-upgrade-auditor', label: 'Dependency Upgrade Auditor', description: 'Find outdated/vulnerable dependencies and plan a safe upgrade path with real breaking-change research', group: 'migration', locked: true },
    { id: 'state-management-migrator', label: 'State Management Migrator', description: 'Migrate between state management libraries (Redux→Zustand/Context, Vuex→Pinia, etc.)', group: 'migration', locked: true },
    { id: 'callback-async-modernizer', label: 'Callback→Async/Await Modernizer', description: 'Convert legacy callback-based code to promises/async-await, preserving exact execution order and error handling', group: 'migration', locked: true },
    { id: 'css-framework-migrator', label: 'CSS Framework Migrator', description: 'Migrate between CSS approaches (Bootstrap→Tailwind, styled-components→CSS Modules, etc.)', group: 'migration', locked: true },

    { id: 'senior-code-reviewer', label: 'Senior Code Reviewer', description: 'Reviews a diff/PR the way a thorough senior engineer would — naming, error handling, edge cases, missed abstractions', group: 'review', locked: true },
    { id: 'db-migration-safety-checker', label: 'Database Migration Safety Checker', description: 'Reviews schema changes for locking behavior, backward compatibility, and safety under concurrent writes', group: 'review', locked: true },
    { id: 'performance-profiler', label: 'Performance Profiler', description: 'Finds N+1 queries, unnecessary re-renders, and inefficient loops, with concrete fixes', group: 'review', locked: true },
    { id: 'error-handling-auditor', label: 'Error Handling Auditor', description: 'Finds silently swallowed errors and inconsistent try/catch patterns across the codebase', group: 'review', locked: true },
    { id: 'dead-code-finder', label: 'Dead Code Finder', description: 'Locates and safely removes unused exports/files using real cross-file analysis, not just a linter\'s local view', group: 'review', locked: true },

    { id: 'accessibility-auditor', label: 'Accessibility Auditor', description: 'WCAG-focused accessibility review that cites concrete violations with fixes', group: 'compliance', locked: true },
    { id: 'license-compliance-auditor', label: 'License Compliance Auditor', description: 'Flags GPL-contamination risk and license incompatibilities across dependencies', group: 'compliance', locked: true },
    { id: 'pii-data-privacy-auditor', label: 'PII/Data Privacy Auditor', description: 'Flags where personal data might be logged or stored insecurely — a compliance lens, distinct from Security Auditor\'s exploit lens', group: 'compliance', locked: true },
    { id: 'i18n-readiness-auditor', label: 'i18n Readiness Auditor', description: 'Finds hardcoded strings that should be internationalized and locale-unsafe date/number formatting', group: 'compliance', locked: true },

    { id: 'new-codebase-onboarding-guide', label: 'New Codebase Onboarding Guide', description: 'Generates the practical "how do I get set up, where do I make my first change" doc a new hire actually needs', group: 'onboarding', locked: true },
    { id: 'api-documentation-generator', label: 'API Documentation Generator', description: 'Reads route handlers/endpoints and produces OpenAPI-style docs from what the code actually does', group: 'onboarding', locked: true },
    { id: 'changelog-generator', label: 'Changelog Generator', description: 'Reads git history since the last release and drafts a changelog matching the project\'s own established style', group: 'onboarding', locked: true },
    { id: 'pr-description-writer', label: 'PR Description Writer', description: 'Reads a diff and writes a proper summary + test plan, optionally incorporating a linked issue/ticket', group: 'onboarding', locked: true },

    { id: 'cicd-pipeline-debugger', label: 'CI/CD Pipeline Debugger', description: 'Diagnoses failing pipeline configs by reading the actual CI YAML and recent run output', group: 'infra', locked: true },
    { id: 'dockerfile-optimizer', label: 'Dockerfile Optimizer', description: 'Reviews Dockerfiles for image bloat, running-as-root, and missed multi-stage build opportunities', group: 'infra', locked: true },
    { id: 'iac-reviewer', label: 'Infrastructure-as-Code Reviewer', description: 'Checks Terraform/CloudFormation/Pulumi configs for common misconfigurations (open security groups, unencrypted storage)', group: 'infra', locked: true },

    { id: 'code-ownership-mapper', label: 'Code Ownership Mapper', description: 'Uses git history to show who has real context on which parts of the codebase, useful for review routing', group: 'team', locked: true },
    { id: 'technical-debt-prioritizer', label: 'Technical Debt Prioritizer', description: 'A focused, prioritized backlog of technical debt with rough effort/impact per item', group: 'team', locked: true },
    { id: 'env-variable-auditor', label: 'Environment Variable Auditor', description: 'Finds env vars referenced in code but missing from .env.example, or vice versa', group: 'team', locked: true },

    { id: 'react-component-auditor', label: 'React Component Auditor', description: 'Hooks misuse, missing dependency arrays, unnecessary re-renders, prop drilling', group: 'specialists', locked: true },
    { id: 'sql-query-optimizer', label: 'SQL Query Optimizer', description: 'Raw SQL/ORM queries checked for missing indexes, N+1 patterns, and inefficient joins', group: 'specialists', locked: true },
    { id: 'python-type-hint-adder', label: 'Python Type Hint Adder', description: 'Adds/improves type hints across an untyped codebase, matching mypy/pyright conventions', group: 'specialists', locked: true },
    { id: 'graphql-schema-reviewer', label: 'GraphQL Schema Reviewer', description: 'N+1 resolver patterns, missing pagination, and breaking changes vs. a previous schema version', group: 'specialists', locked: true },

    { id: 'changelog-aware-release-assistant', label: 'Changelog-Aware Release Assistant', description: 'Bumps version strings consistently across a project/monorepo and drafts release notes matching established style', group: 'release', locked: true },
    { id: 'feature-flag-cleanup', label: 'Feature Flag Cleanup', description: 'Finds stale/permanently-on flags and removes the dead branches around them', group: 'release', locked: true },
    { id: 'breaking-change-detector', label: 'Breaking Change Detector', description: 'Diffs the current branch against main/a previous tag, flags changes to exported functions/public APIs', group: 'release', locked: true },

    { id: 'flaky-test-diagnostician', label: 'Flaky Test Diagnostician', description: 'Investigates one specific failing/flaky test and either fixes it or explains the real root cause', group: 'testing', locked: true },
    { id: 'test-coverage-gap-report', label: 'Test Coverage Gap Report', description: 'Runs the project\'s own coverage tool, then prioritizes which uncovered lines actually matter', group: 'testing', locked: true }
];

interface CacheEntry {
    templates: CatalogEntry[];
    ts: number;
    everFetched: boolean;
}

let _memCache: { templates: CatalogEntry[]; ts: number } | null = null;

async function fetchCatalog(context: vscode.ExtensionContext): Promise<CatalogEntry[]> {
    const cfg = vscode.workspace.getConfiguration('freebird');
    const licenseKey = cfg.get<string>('licenseKey', '').trim();
    const templateLicenseKey = cfg.get<string>('templateLicenseKey', '').trim();

    const persisted = context.globalState.get<CacheEntry>('templateCatalogCache');

    if (_memCache && Date.now() - _memCache.ts < CACHE_TTL_MS) {
        return _memCache.templates;
    }
    if (persisted && Date.now() - persisted.ts < CACHE_TTL_MS) {
        _memCache = { templates: persisted.templates, ts: persisted.ts };
        return persisted.templates;
    }

    try {
        const res = await fetch(`${API_BASE}/api/templates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ licenseKey, templateLicenseKey }),
            signal: AbortSignal.timeout(6000)
        });

        if (!res.ok) return fallbackToCache(persisted);

        const data = await res.json() as { templates: CatalogEntry[] };
        const templates = data.templates ?? [];

        const entry: CacheEntry = { templates, ts: Date.now(), everFetched: true };
        await context.globalState.update('templateCatalogCache', entry);
        _memCache = { templates, ts: Date.now() };
        return templates;

    } catch {
        return fallbackToCache(persisted);
    }
}

function fallbackToCache(cached: CacheEntry | null | undefined): CatalogEntry[] {
    if (cached && cached.everFetched && Date.now() - cached.ts < OFFLINE_TTL_MS) {
        _memCache = { templates: cached.templates, ts: cached.ts };
        return cached.templates;
    }
    return OFFLINE_MANIFEST.map(m => ({ ...m }));
}

export function clearTemplateCatalogCache(context: vscode.ExtensionContext): void {
    context.globalState.update('templateCatalogCache', undefined);
    _memCache = null;
}

/**
 * Whether the paid catalog currently has at least one unlocked entry — used
 * right after activating a template license key to confirm it actually took.
 * The backend applies one entitled/not-entitled flag uniformly across the
 * whole catalog (see api/templates.js), so "any unlocked" and "all unlocked"
 * are equivalent as long as the catalog is non-empty.
 */
export async function isTemplateLibraryUnlocked(context: vscode.ExtensionContext): Promise<boolean> {
    const paid = await fetchCatalog(context);
    return paid.some(t => !t.locked);
}

export interface MergedTemplateItem {
    id: string;
    label: string;
    description: string;
    locked: boolean;
    prompt?: string;
}

/**
 * The free, bundled templates (always unlocked) plus the fetched paid
 * catalog (locked/unlocked per entitlement). Free templates always come
 * first — they're the always-available default, paid ones are the upsell.
 */
export async function getMergedTemplates(context: vscode.ExtensionContext): Promise<MergedTemplateItem[]> {
    const free: MergedTemplateItem[] = PROMPT_TEMPLATES.map((t: PromptTemplate) => ({
        id: t.id, label: t.label, description: t.description, locked: false, prompt: t.prompt
    }));

    const paid = await fetchCatalog(context);
    const paidItems: MergedTemplateItem[] = paid.map(t => ({
        id: t.id, label: t.label, description: t.description, locked: t.locked, prompt: t.prompt
    }));

    return [...free, ...paidItems];
}
