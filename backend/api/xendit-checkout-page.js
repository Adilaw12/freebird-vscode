// backend/api/xendit-checkout-page.js — GET /pay-local
// Static form (email, country, e-wallet channel) for the "Pay with Local
// Methods (VN/ID)" entry point. No framework, matching api/success.js's
// plain-HTML pattern. Submits to xendit-checkout.js, then redirects the
// browser to whatever URL that returns.

export default async function handler(req, res) {
    const error = req.query?.error ? '<p class="error">That payment method didn\'t go through — please try again or pick a different one.</p>' : '';

    return res.status(200).send(page(
        '🚀 Pay with Local Methods',
        `<p style="margin-bottom:16px">For customers in Vietnam and Indonesia — e-wallets and QR payments, billed monthly.</p>
         ${error}
         <form id="f">
           <label>Email
             <input type="email" name="email" required placeholder="you@example.com">
           </label>
           <label>Country
             <select name="country" id="country" required>
               <option value="">Select…</option>
               <option value="ID">Indonesia</option>
               <option value="VN">Vietnam</option>
             </select>
           </label>
           <label>Payment method
             <select name="channelCode" id="channelCode" required disabled>
               <option value="">Select a country first…</option>
             </select>
           </label>
           <button type="submit" id="submitBtn">Continue</button>
         </form>
         <p id="status" style="margin-top:12px;opacity:0.8"></p>
         <script>
           var CHANNELS = {
             ID: [['OVO','OVO'], ['DANA','DANA'], ['SHOPEEPAY','ShopeePay']],
             VN: [['MOMO','MoMo'], ['ZALOPAY','ZaloPay']]
           };
           var countrySel = document.getElementById('country');
           var channelSel = document.getElementById('channelCode');
           countrySel.addEventListener('change', function() {
             var opts = CHANNELS[countrySel.value] || [];
             channelSel.innerHTML = opts.map(function(o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('');
             channelSel.disabled = opts.length === 0;
           });
           document.getElementById('f').addEventListener('submit', async function(e) {
             e.preventDefault();
             var btn = document.getElementById('submitBtn');
             var status = document.getElementById('status');
             btn.disabled = true;
             status.textContent = 'Setting up your payment…';
             var body = {
               email: countrySel.form.email.value,
               country: countrySel.value,
               channelCode: channelSel.value
             };
             try {
               var r = await fetch('/api/xendit-checkout', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify(body)
               });
               var data = await r.json();
               if (!r.ok || !data.redirectUrl) {
                 status.textContent = data.error || 'Something went wrong — please try again.';
                 btn.disabled = false;
                 return;
               }
               window.location = data.redirectUrl;
             } catch (err) {
               status.textContent = 'Network error — please try again.';
               btn.disabled = false;
             }
           });
         </script>`
    ));
}

function page(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Freebird AI</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         max-width: 480px; margin: 60px auto; padding: 0 24px;
         color: #e8e0ff; background: #1a1a2e; }
  h1 { font-size: 1.6em; margin-bottom: 12px; }
  form { display: flex; flex-direction: column; gap: 14px; }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 0.9em; opacity: 0.9; }
  input, select { background: #2a2a4e; border: 1px solid #4a4a8e; border-radius: 6px;
                  color: #e8e0ff; padding: 10px 12px; font-size: 1em; font-family: inherit; }
  button { background: #6c63ff; color: #fff; border: none; border-radius: 6px;
           padding: 10px 20px; cursor: pointer; font-size: 0.95em; margin-top: 4px; }
  button:disabled { opacity: 0.6; cursor: default; }
  button:hover:not(:disabled) { background: #7c73ff; }
  .error { background: #4e2a2a; border: 1px solid #8e4a4a; border-radius: 6px; padding: 10px 12px; font-size: 0.9em; }
  a { color: #a89aff; }
</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>`;
}
