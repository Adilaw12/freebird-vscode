// test/template-welcome.test.js — every device gets the whole prompt-template
// library free for its first 7 days, and it must lock again after that.
//
// Server: the window is anchored to the first time the machine id is seen (not
// to anything the client can reset), and a client-reported install time can
// only shorten it. Client: a cached catalog that was unlocked only by the
// window must stop serving its prompts once the window closes, including
// offline.

const vscodeMock = require('./bootstrap');
const path = require('path');
const { Redis } = require('./mocks/upstash-redis.js');
const { makeFakeContext, suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const DAY = 24 * 60 * 60 * 1000;

async function withFetch(impl, fn) {
    const real = global.fetch;
    global.fetch = impl;
    try { return await fn(); } finally { global.fetch = real; }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function run() {
    const modPath = path.join(__dirname, '..', 'backend', 'lib', 'templateWelcome.js');
    const {
        getWelcomeEndsAt, WELCOME_MS, peekWelcomeEndsAt, templateHaikuDailyLimit,
        TEMPLATE_HAIKU_DAILY, TEMPLATE_HAIKU_DAILY_WELCOME
    } = await import(`file://${modPath}`);

    suite('server window — anchored to first sight of the machine id');
    {
        const redis = Redis.fromEnv();
        const t0 = 1_800_000_000_000;
        const ends = await getWelcomeEndsAt(redis, 'machine-1', t0, t0);
        check('a brand-new device gets exactly 7 days', ends === t0 + WELCOME_MS);

        check('still open on day 6', await getWelcomeEndsAt(redis, 'machine-1', t0, t0 + 6 * DAY) === t0 + WELCOME_MS);
        check('closed on day 7', await getWelcomeEndsAt(redis, 'machine-1', t0, t0 + 7 * DAY) === null);
        check('stays closed afterwards', await getWelcomeEndsAt(redis, 'machine-1', t0, t0 + 30 * DAY) === null);
    }

    suite('server window — the client cannot restart or extend it');
    {
        const redis = Redis.fromEnv();
        const t0 = 1_800_000_000_000;
        await getWelcomeEndsAt(redis, 'machine-2', t0, t0);
        // 10 days later the client claims it was installed "just now" (e.g. a
        // reinstall or a doctored value) — the stored first-seen wins.
        const later = t0 + 10 * DAY;
        check('a fresh installedAt on day 10 does not reopen the window', await getWelcomeEndsAt(redis, 'machine-2', later, later) === null);
    }

    suite('server window — a reported install time can only shorten it');
    {
        const redis = Redis.fromEnv();
        const now = 1_800_000_000_000;
        const future = await getWelcomeEndsAt(redis, 'machine-3', now + 5 * DAY, now);
        check('a future-dated install time is clamped to now (no bonus days)', future === now + WELCOME_MS);

        const ancient = await getWelcomeEndsAt(Redis.fromEnv(), 'machine-4', now - 100 * DAY, now);
        check('an install time older than 7 days is clamped, so the window is already over', ancient === null);

        const threeDaysAgo = await getWelcomeEndsAt(Redis.fromEnv(), 'machine-5', now - 3 * DAY, now);
        check('installed 3 days ago -> 4 days left', threeDaysAgo === now + 4 * DAY);

        const garbage = await getWelcomeEndsAt(Redis.fromEnv(), 'machine-6', 'not-a-number', now);
        check('a garbage install time falls back to starting now', garbage === now + WELCOME_MS);
    }

    suite('server window — missing machine id is simply locked');
    {
        const redis = Redis.fromEnv();
        check('no machineId -> no window', await getWelcomeEndsAt(redis, undefined, Date.now()) === null);
        check('blank machineId -> no window', await getWelcomeEndsAt(redis, '   ', Date.now()) === null);
        check('non-string machineId -> no window', await getWelcomeEndsAt(redis, 12345, Date.now()) === null);
    }

    suite('Haiku template bonus — 2/day on any template during the window, 1/day on the free 3 after');
    {
        const freeIds = ['codebase-cartographer', 'security-auditor', 'multi-file-test-engineer'];
        const allIds = [...freeIds, 'framework-migration-planner', 'senior-code-reviewer'];
        const args = (templateId, machineId) => ({ templateId, machineId, freeIds, allIds });
        const t0 = 1_800_000_000_000;

        const redis = Redis.fromEnv();
        await getWelcomeEndsAt(redis, 'in-window', t0, t0);            // device has a window starting at t0

        check('inside the window a PAID template gets the Haiku bonus, twice a day',
            await templateHaikuDailyLimit(redis, args('framework-migration-planner', 'in-window'), t0 + DAY) === TEMPLATE_HAIKU_DAILY_WELCOME && TEMPLATE_HAIKU_DAILY_WELCOME === 2);
        check('inside the window a free template also gets 2/day',
            await templateHaikuDailyLimit(redis, args('security-auditor', 'in-window'), t0 + DAY) === 2);
        check('after day 7 a paid template gets nothing', await templateHaikuDailyLimit(redis, args('framework-migration-planner', 'in-window'), t0 + 8 * DAY) === 0);
        check('after day 7 the free templates fall back to 1/day', await templateHaikuDailyLimit(redis, args('security-auditor', 'in-window'), t0 + 8 * DAY) === TEMPLATE_HAIKU_DAILY && TEMPLATE_HAIKU_DAILY === 1);
        check('a device with no window gets 1/day on free templates, 0 on paid',
            await templateHaikuDailyLimit(redis, args('security-auditor', 'never-seen'), t0) === 1 &&
            await templateHaikuDailyLimit(redis, args('senior-code-reviewer', 'never-seen'), t0) === 0);
        check('an unknown or missing template id never qualifies',
            await templateHaikuDailyLimit(redis, args('made-up-id', 'in-window'), t0 + DAY) === 0 &&
            await templateHaikuDailyLimit(redis, args(undefined, 'in-window'), t0 + DAY) === 0);

        // A chat request must never be what opens a window.
        const fresh = Redis.fromEnv();
        check('peek never starts a window', await peekWelcomeEndsAt(fresh, 'chat-only-device', t0) === null);
        await templateHaikuDailyLimit(fresh, args('senior-code-reviewer', 'chat-only-device'), t0);
        check('and a bonus lookup does not either', await peekWelcomeEndsAt(fresh, 'chat-only-device', t0) === null);
        check('peek sees a window the catalog fetch already started', await peekWelcomeEndsAt(redis, 'in-window', t0 + DAY) === t0 + WELCOME_MS);
    }

    const { getMergedTemplates, getTemplateWelcomeEndsAt, clearTemplateCatalogCache, recordFirstSeen } = require(path.join(OUT, 'agent/templateCatalog.js'));
    const paidIds = ['framework-migration-planner', 'senior-code-reviewer'];

    suite('client — unlocked during the window, with a countdown');
    {
        vscodeMock.__setMockConfig({ 'freebird.licenseKey': '', 'freebird.templateLicenseKey': '' });
        const ctx = makeFakeContext();
        const endsAt = Date.now() + 5 * DAY;
        let sent;
        const items = await withFetch(async (_url, init) => {
            sent = JSON.parse(init.body);
            return json({ templates: paidIds.map(id => ({ id, label: id, description: '', locked: false, prompt: 'P' })), welcomeEndsAt: endsAt });
        }, () => getMergedTemplates(ctx));

        const paid = items.filter(i => paidIds.includes(i.id));
        check('paid templates arrive unlocked with their prompts', paid.length === 2 && paid.every(i => !i.locked && i.prompt === 'P'));
        check('the countdown is exposed', getTemplateWelcomeEndsAt(ctx) === endsAt);
        check('the request carries a machine id and an install time', 'machineId' in sent && typeof sent.installedAt === 'number');
    }

    suite('client — the clock starts at first use, not at the first picker open');
    {
        const ctx = makeFakeContext();
        clearTemplateCatalogCache(ctx);
        const realNow = Date.now;
        const day0 = realNow();
        try {
            Date.now = () => day0;
            recordFirstSeen(ctx);                     // activation on day 0
            Date.now = () => day0 + 5 * DAY;          // user first opens the picker on day 5
            recordFirstSeen(ctx);                     // a later call must not move the stamp
            let sent;
            await withFetch(async (_u, init) => { sent = JSON.parse(init.body); return json({ templates: [], welcomeEndsAt: null }); },
                () => getMergedTemplates(ctx));
            check('the install time sent to the server is day 0, not day 5', sent.installedAt === day0);
        } finally {
            Date.now = realNow;
        }
    }

    suite('client — locked once the window closes, even offline');
    {
        const ctx = makeFakeContext();
        clearTemplateCatalogCache(ctx); // the module keeps an in-memory cache across scenarios
        // A catalog cached while the window was open, which has since closed.
        await ctx.globalState.update('templateCatalogCache', {
            templates: paidIds.map(id => ({ id, label: id, description: '', locked: false, prompt: 'SECRET' })),
            ts: Date.now() - 30 * 60 * 1000,        // fresh enough to be served by the 1h cache...
            everFetched: true,
            welcomeEndsAt: Date.now() - 1000         // ...except the window is over
        });

        const offline = await withFetch(async () => { throw new Error('offline'); }, () => getMergedTemplates(ctx));
        const leaked = offline.filter(i => i.prompt === 'SECRET');
        check('offline: cached unlocked prompts are not served after the window ends', leaked.length === 0);
        check('offline: the countdown is gone', getTemplateWelcomeEndsAt(ctx) === null);

        clearTemplateCatalogCache(ctx);
        const online = await withFetch(async () =>
            json({ templates: paidIds.map(id => ({ id, label: id, description: '', locked: true })), welcomeEndsAt: null }),
            () => getMergedTemplates(makeFakeContext()));
        check('online: the server\'s locked catalog is shown as locked', online.filter(i => paidIds.includes(i.id)).every(i => i.locked && !i.prompt));
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
