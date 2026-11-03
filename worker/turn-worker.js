// Cloudflare Worker: hands out short-lived TURN credentials to the ClickSync web app.
// Paste this into the Worker's editor in the Cloudflare dashboard and deploy.
//
// Secrets (Settings -> Variables and Secrets), never put them in the code or in git:
//   TURN_KEY_ID         the "TURN Token ID"
//   TURN_KEY_API_TOKEN  the TURN key API token
//
// Optional plain variable:
//   ALLOWED_ORIGINS     extra origins allowed to call this Worker, comma-separated
//
// The app calls this once when it starts hosting/joining (and then caches the answer
// in localStorage for a day), so the request count stays tiny.

const TTL = 86400; // credential lifetime in seconds (the app reuses them until ~2 h before expiry)

// Only browsers on these origins may read the response. Add your own site (e.g. a custom domain) with the
// optional ALLOWED_ORIGINS variable: a comma-separated list such as "https://metronome.example.com".
const ALLOWED_ORIGIN = /^(https:\/\/flugge00\.github\.io|http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?)$/;

// Per-isolate cache so a burst of requests makes at most one call to Cloudflare's API.
let cached;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    const extra = (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
    if (!ALLOWED_ORIGIN.test(origin) && !extra.includes(origin)) return new Response('Forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });

    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ error: 'not configured' }, 500);

    // Reuse for an hour; the credentials themselves last a day.
    if (cached && Date.now() - cached.at < 3600_000) return json(cached.body);

    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL }),
      },
    );
    if (!res.ok) return json({ error: 'upstream', status: res.status }, 502);

    const { iceServers } = await res.json();
    // Port 53 is blocked by browsers and would only time out.
    const clean = iceServers.map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !u.includes(':53?') && !u.endsWith(':53')) }));
    cached = { at: Date.now(), body: { iceServers: clean, ttl: TTL } };
    return json(cached.body);
  },
};
