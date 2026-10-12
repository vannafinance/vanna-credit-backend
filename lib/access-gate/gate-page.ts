/**
 * Server-rendered HTML for the access gate. `proxy.ts` returns it for every page request that has no
 * valid access cookie, and POST /api/access returns it (with an error) for no-JS form submissions.
 *
 * Deliberately a standalone document, not an App Router page: the root layout mounts the whole app
 * shell (navbar, wallet adapter, price feeds, RPC subscriptions), none of which should run — or be
 * shipped — before the visitor is let in. Styling mirrors the V3 tokens in app/v3.css (light +
 * dark via prefers-color-scheme). The access code itself is never written into this page: the tiny
 * inline script only POSTs what the user typed to /api/access and reloads on success.
 */

export type GatePageOptions = {
  /** Error line shown under the input (already user-facing text). */
  error?: string;
  /** Path to return to after a successful no-JS form submit. */
  next?: string;
  /** Show a numeric keypad on mobile (set when the configured code is digits-only). */
  numeric?: boolean;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Normalises a post-login return path to a same-origin absolute path ("/..."), rejecting
 * protocol-relative ("//evil") and backslash tricks so it can't become an open redirect.
 */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  if (/[\u0000-\u001f]/.test(raw)) return "/";
  if (raw.startsWith("/api/")) return "/";
  return raw;
}

const STYLES = `
:root{
  --bg:#ffffff;--card:#ffffff;--field:#ffffff;--line:#e8e8e8;--line-2:#e2e2e2;
  --title:#181822;--text:#111111;--label:#777777;--quiet:#9ca3af;
  --violet:#703ae6;--danger:#c9333b;--danger-bg:rgba(201,51,59,.08);
  --grad:linear-gradient(135deg,#fc5457 10%,#703ae6 80%);
  --btn-off-bg:#d4d4d8;--btn-off-fg:#ffffff;--shadow:rgba(17,17,34,.06);
  --glow:rgba(112,58,230,.10);
  color-scheme:light;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#111111;--card:#1a1a1a;--field:#111111;--line:#2a2a2a;--line-2:#333333;
    --title:#ffffff;--text:#ffffff;--label:#a7a7a7;--quiet:#9ca3af;
    --violet:#703ae6;--danger:#f0666e;--danger-bg:rgba(240,102,110,.10);
    --btn-off-bg:#333333;--btn-off-fg:#888888;--shadow:rgba(0,0,0,.5);
    --glow:rgba(154,114,240,.14);
    color-scheme:dark;
  }
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{
  background:var(--bg);color:var(--text);
  font-family:"Plus Jakarta Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;
  display:flex;align-items:center;justify-content:center;
  padding:24px 16px;min-height:100vh;min-height:100dvh;
  background-image:radial-gradient(60% 50% at 50% 0%,var(--glow),transparent 70%);
  background-repeat:no-repeat;
}
.wrap{width:100%;max-width:400px;display:flex;flex-direction:column;align-items:center;gap:24px}
.logo{display:block;height:40px;width:auto}
.logo img{height:40px;width:auto;display:block}
.card{
  width:100%;background:var(--card);border:1px solid var(--line);border-radius:16px;
  padding:28px 24px 24px;box-shadow:0 12px 40px var(--shadow);
}
h1{margin:0;font-size:22px;font-weight:700;color:var(--title);letter-spacing:-.01em;text-wrap:balance}
.sub{margin:6px 0 20px;color:var(--label);font-size:14px}
label{display:block;font-size:12px;font-weight:600;color:var(--label);margin-bottom:8px}
input{
  width:100%;height:52px;border-radius:12px;border:1px solid var(--line-2);background:var(--field);
  color:var(--text);font:inherit;font-size:20px;font-weight:600;letter-spacing:.3em;text-align:center;
  padding:0 16px;outline:none;transition:border-color .15s,box-shadow .15s;
}
input::placeholder{color:var(--quiet);letter-spacing:.3em;font-weight:500}
input:focus{border-color:var(--violet);box-shadow:0 0 0 3px rgba(112,58,230,.18)}
input[aria-invalid="true"]{border-color:var(--danger)}
input::selection{background:rgba(112,58,230,.32);color:var(--text)}
.err{
  margin:10px 0 0;padding:8px 12px;border-radius:10px;background:var(--danger-bg);
  color:var(--danger);font-size:13px;font-weight:500;
}
.err[hidden]{display:none}
button{
  margin-top:16px;width:100%;height:48px;border:0;border-radius:12px;cursor:pointer;
  font:inherit;font-size:15px;font-weight:600;color:#fff;background:var(--grad);
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
}
button:hover{filter:brightness(1.06)}
button:disabled{background:var(--btn-off-bg);color:var(--btn-off-fg);cursor:not-allowed;filter:none}
button:focus-visible{outline:2px solid var(--violet);outline-offset:2px}
.foot{color:var(--quiet);font-size:12px;text-align:center}
.spin{width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:s .7s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
`;

// Client behaviour only: submit what the user typed, show the server's verdict. No secrets here.
const SCRIPT = `
(function(){
  var f=document.getElementById("gate");if(!f||!window.fetch)return;
  var i=document.getElementById("code"),b=document.getElementById("go"),e=document.getElementById("err");
  function show(m){e.textContent=m;e.hidden=false;i.setAttribute("aria-invalid","true");i.focus();i.select();}
  i.addEventListener("input",function(){if(!e.hidden){e.hidden=true;i.removeAttribute("aria-invalid");}});
  f.addEventListener("submit",function(ev){
    ev.preventDefault();
    var v=i.value.trim();if(!v){show("Enter your access code.");return;}
    b.disabled=true;var label=b.innerHTML;b.innerHTML='<span class="spin" aria-hidden="true"></span>Checking';
    fetch("/api/access",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({code:v})})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {s:r.status,j:j};});})
      .then(function(x){
        if(x.s===200&&x.j&&x.j.ok){b.innerHTML="Entering…";window.location.reload();return;}
        b.disabled=false;b.innerHTML=label;
        show((x.j&&x.j.error)||"Something went wrong. Please try again.");
      })
      .catch(function(){b.disabled=false;b.innerHTML=label;show("Network error. Please try again.");});
  });
})();
`;

/** Full HTML document for the gate. */
export function renderGatePage(opts: GatePageOptions = {}): string {
  const error = opts.error ? escapeHtml(opts.error) : "";
  const next = escapeHtml(safeNextPath(opts.next));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>Access · Vanna</title>
<link rel="icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap">
<style>${STYLES}</style>
</head>
<body>
<main class="wrap">
  <picture class="logo">
    <source srcset="/logos/vanna-white.png" media="(prefers-color-scheme: dark)">
    <img src="/logos/vanna.png" alt="Vanna" width="154" height="48">
  </picture>
  <form id="gate" class="card" method="post" action="/api/access" novalidate>
    <h1>Enter access code</h1>
    <p class="sub">Vanna is in private testing. Enter your access code to continue.</p>
    <label for="code">Access code</label>
    <input id="code" name="code" type="text" inputmode="${opts.numeric === false ? "text" : "numeric"}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64" placeholder="••••" autofocus required${error ? ' aria-invalid="true"' : ""} aria-describedby="err">
    <input type="hidden" name="next" value="${next}">
    <p id="err" class="err" role="alert"${error ? "" : " hidden"}>${error}</p>
    <button id="go" type="submit">Continue</button>
  </form>
  <p class="foot">Don’t have a code? Reach out to the Vanna team.</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
