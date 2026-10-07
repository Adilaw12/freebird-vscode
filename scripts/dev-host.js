#!/usr/bin/env node
// scripts/dev-host.js — `npm run dev`
//
// Opens an Extension Development Host on this checkout and keeps it fresh:
//   1. launches VS Code with an ISOLATED profile (so your normal VS Code, its
//      settings and its installed Freebird are untouched, and no Marketplace copy
//      can shadow the dev build),
//   2. runs the TypeScript compiler in watch mode; the extension reloads itself
//      when out/ or media/ change (see src/devReload.ts).
//
// Optional: --license FB-XXXX-... stores a Pro licence key in the isolated
// profile only (never in the repo). It is remembered for next time.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const base = path.join(os.homedir(), '.freebird-dev');
const userData = path.join(base, 'profile');
const extensions = path.join(base, 'extensions');
const settingsFile = path.join(userData, 'User', 'settings.json');

const args = process.argv.slice(2);
const li = args.indexOf('--license');
const license = li >= 0 ? args[li + 1] : process.env.FREEBIRD_DEV_LICENSE;

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.mkdirSync(extensions, { recursive: true });

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* first run */ }
settings['telemetry.telemetryLevel'] = settings['telemetry.telemetryLevel'] ?? 'off';
settings['workbench.startupEditor'] = 'none';
if (license) {
    if (!/^[A-Z]{2,4}-[A-Z0-9-]{8,}$/i.test(license)) { console.error('That does not look like a Freebird licence key (e.g. FB-XXXX-XXXX-XXXX-XXXX; older keys start OP-).'); process.exit(1); }
    settings['freebird.licenseKey'] = license.trim();
    console.log('Pro licence key stored in the dev profile (' + settingsFile + ').');
}
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

const isWin = process.platform === 'win32';
const code = isWin ? 'code.cmd' : 'code';
const launch = spawn(code, [
    '--user-data-dir', userData,
    '--extensions-dir', extensions,
    '--extensionDevelopmentPath', root,
    '--new-window', root
], { detached: true, stdio: 'ignore', shell: isWin });
launch.unref();
console.log('Dev host launching (isolated profile: ' + base + ').');
console.log('Watching for changes — the dev host reloads itself after each rebuild. Ctrl+C stops the watcher.\n');

const tsc = spawn(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-watch', '-p', root, '--preserveWatchOutput'], { stdio: 'inherit' });
tsc.on('exit', c => process.exit(c ?? 0));
