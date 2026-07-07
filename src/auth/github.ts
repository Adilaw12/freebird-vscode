import * as vscode from 'vscode';

// TODO(Adisa): register a GitHub OAuth App with Device Flow enabled at
// https://github.com/settings/developers → New OAuth App → check
// "Enable Device Flow" → paste the Client ID here. No client secret is
// needed for the device flow steps run directly against GitHub below.
export const GITHUB_CLIENT_ID = 'REPLACE_WITH_GITHUB_OAUTH_CLIENT_ID';

const API_BASE       = 'https://freebird-backend.vercel.app';
const SESSION_SECRET_KEY = 'freebird.githubSession';

export interface GithubSession {
    sessionToken: string;
    login: string;
    avatarUrl?: string | null;
}

interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
}

interface AccessTokenResponse {
    access_token?: string;
    error?: string;
    error_description?: string;
}

/** Read the stored session (if any) from SecretStorage — never plain globalState. */
export async function getStoredSession(context: vscode.ExtensionContext): Promise<GithubSession | null> {
    const raw = await context.secrets.get(SESSION_SECRET_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as GithubSession;
    } catch {
        return null;
    }
}

export async function clearSession(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(SESSION_SECRET_KEY);
}

/**
 * Runs the GitHub OAuth Device Flow end-to-end:
 *  1. Request a device code directly from GitHub (no secret needed for this step)
 *  2. Show the user their one-time code and open github.com/login/device
 *  3. Poll GitHub until they've authorized it
 *  4. Send the resulting GitHub access token to OUR backend, which verifies it
 *     against GitHub's API itself and returns a signed Freebird session token
 * Throws on cancellation, timeout, or failure — callers should catch and show
 * a message rather than letting it propagate silently.
 */
export async function signInWithGitHub(context: vscode.ExtensionContext): Promise<GithubSession> {
    if (GITHUB_CLIENT_ID.startsWith('REPLACE_WITH')) {
        throw new Error('GitHub sign-in is not configured yet (missing OAuth Client ID).');
    }

    const codeRes = await fetch('https://github.com/login/device/code', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body:    JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: 'read:user' })
    });
    if (!codeRes.ok) {
        throw new Error('Could not start GitHub sign-in. Please try again.');
    }
    const codeData = await codeRes.json() as DeviceCodeResponse;

    await vscode.env.clipboard.writeText(codeData.user_code);
    const choice = await vscode.window.showInformationMessage(
        `Sign in to Freebird with GitHub — code ${codeData.user_code} has been copied to your clipboard. ` +
        `Paste it on the GitHub page that opens.`,
        'Open GitHub',
        'Cancel'
    );
    if (choice !== 'Open GitHub') {
        throw new Error('CANCELLED');
    }
    await vscode.env.openExternal(vscode.Uri.parse(codeData.verification_uri));

    const deadline = Date.now() + codeData.expires_in * 1000;
    let intervalMs = Math.max(codeData.interval, 5) * 1000;

    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));

        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                client_id:   GITHUB_CLIENT_ID,
                device_code: codeData.device_code,
                grant_type:  'urn:ietf:params:oauth:grant-type:device_code'
            })
        });
        const tokenData = await tokenRes.json() as AccessTokenResponse;

        if (tokenData.access_token) {
            const sessionRes = await fetch(`${API_BASE}/api/auth-github`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ githubAccessToken: tokenData.access_token }),
                signal:  AbortSignal.timeout(10_000)
            });
            if (!sessionRes.ok) {
                throw new Error('Could not verify GitHub sign-in with Freebird servers.');
            }
            const session = await sessionRes.json() as GithubSession;
            await context.secrets.store(SESSION_SECRET_KEY, JSON.stringify(session));
            return session;
        }

        switch (tokenData.error) {
            case 'authorization_pending':
                continue; // user hasn't approved yet — keep polling
            case 'slow_down':
                intervalMs += 5000;
                continue;
            case 'expired_token':
                throw new Error('Sign-in code expired. Please try again.');
            case 'access_denied':
                throw new Error('Sign-in was cancelled.');
            default:
                throw new Error(tokenData.error_description || 'GitHub sign-in failed.');
        }
    }

    throw new Error('Sign-in timed out. Please try again.');
}
