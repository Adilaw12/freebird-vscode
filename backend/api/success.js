import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
    const { session_id } = req.query;

    if (!session_id) {
        return res.status(400).send(page('Missing session ID', '<p>Something went wrong. Please contact support.</p>'));
    }

    const key = await redis.get(`session:${session_id}`);

    if (!key) {
        // Webhook may still be processing — auto-refresh after 3 seconds
        return res.status(200).send(page(
            'Processing your subscription…',
            `<p>Your license key is being generated &mdash; this usually takes a few seconds.</p>
             <p>This page will refresh automatically.</p>
             <script>setTimeout(function(){ location.reload(); }, 3000);</script>`
        ));
    }

    return res.status(200).send(page(
        '🚀 Welcome to OpenPilot Pro!',
        `<p style="margin-bottom:12px">Your license key:</p>
         <div class="key-box" id="key">${key}</div>
         <button onclick="navigator.clipboard.writeText('${key}').then(function(){ this.textContent='Copied!'; }.bind(this))">
           Copy to clipboard
         </button>
         <hr style="margin:24px 0">
         <h3>How to activate</h3>
         <ol>
           <li>Open VS Code</li>
           <li>Press <kbd>Ctrl+Shift+P</kbd> (or <kbd>Cmd+Shift+P</kbd> on Mac)</li>
           <li>Run <strong>OpenPilot: Activate Pro License</strong></li>
           <li>Paste the key above</li>
         </ol>
         <p style="margin-top:16px;opacity:0.7">
           Save this key somewhere safe &mdash; you can also find it by
           <a href="mailto:support@tenlabs.io">contacting support</a> with your email.
         </p>`
    ));
}

function page(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — OpenPilot</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         max-width: 560px; margin: 60px auto; padding: 0 24px;
         color: #e8e0ff; background: #1a1a2e; }
  h1 { font-size: 1.6em; margin-bottom: 12px; }
  h3 { margin: 0 0 8px; }
  .key-box { font-family: monospace; font-size: 1.3em; letter-spacing: 0.1em;
             background: #2a2a4e; padding: 14px 18px; border-radius: 8px;
             border: 1px solid #4a4a8e; margin-bottom: 12px; word-break: break-all; }
  button { background: #6c63ff; color: #fff; border: none; border-radius: 6px;
           padding: 8px 20px; cursor: pointer; font-size: 0.95em; }
  button:hover { background: #7c73ff; }
  ol { padding-left: 20px; line-height: 2; }
  kbd { background: #2a2a4e; border: 1px solid #4a4a8e; border-radius: 3px;
        padding: 1px 6px; font-family: monospace; }
  a { color: #a89aff; }
  hr { border: none; border-top: 1px solid #3a3a6e; }
</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>`;
}
