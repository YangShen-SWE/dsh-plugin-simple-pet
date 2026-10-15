import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// Ephemeral capability channel. No email, command, grant or capability is written to disk.
// This protects the HTTP boundary, not other processes running as the same Windows user.
export async function startPanelAccounts({ read, cycle, runtime = () => ({ active: true }) }) {
  const token = randomBytes(32).toString('hex');
  let closed = false, busy = false;
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', Connection: 'close' }); res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization;
    if (closed || req.socket.remoteAddress !== '127.0.0.1' || req.headers.origin != null
      || typeof auth !== 'string' || auth.length !== 71 || !/^Bearer [a-f0-9]{64}$/.test(auth)
      || !timingSafeEqual(Buffer.from(auth), Buffer.from(`Bearer ${token}`))) return reply(403, { error: '未授权' });
    if (req.url !== '/panel') return reply(404, {});
    if (req.method !== 'GET' && req.method !== 'POST') return reply(405, {});
    if (!runtime()?.active) return reply(409, { error: '桌宠未就绪' });
    try {
      if (req.method === 'GET') return reply(200, await read());
      if (busy) return reply(409, { error: '切换进行中' });
      busy = true;
      try {
        if (typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) return reply(415, {});
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1024) return reply(413, {}); chunks.push(chunk); }
        let body;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { return reply(400, {}); }
        if (!body || Object.keys(body).sort().join(',') !== 'action,grant' || body.action !== 'cycle'
          || typeof body.grant !== 'string' || body.grant.length !== 64 || !/^[a-f0-9]+$/.test(body.grant)) return reply(400, {});
        await cycle(body.grant);
        return reply(200, { ...(await read()), ok: true });
      } finally { busy = false; }
    } catch { reply(409, { error: '切换未确认，请核验订阅插件；不会自动重试。' }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 5000;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  return { url: `http://127.0.0.1:${server.address().port}/panel`, token,
    close() { closed = true; server.close(); for (const socket of sockets) socket.destroy(); } };
}

export function createPanelCycle({ control, grant, ready }) {
  let busy = false;
  return async expected => {
    if (busy || !ready() || grant() !== expected) throw new Error('disabled');
    busy = true;
    try {
      const list = await control.list();
      if (!ready() || grant() !== expected || !list.enabled || list.accounts.length < 2) throw new Error('disabled');
      const current = list.accounts.findIndex(row => row.current === true);
      if (current < 0) throw new Error('invalid');
      const next = list.accounts[(current + 1) % list.accounts.length];
      // The explicit panel click is consent; the controller retains all freshness checks.
      return await control.switch({ token: list.token, target: next.target, confirm: true });
    } finally { busy = false; }
  };
}
