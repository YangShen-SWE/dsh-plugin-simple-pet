const MAX_BODY = 8192;
function respond(res, status, body, method) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(method === 'HEAD' ? undefined : JSON.stringify(body));
}
async function readBody(req) {
  const type = req.headers?.['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw Object.assign(new Error('仅接受 JSON 设置。'), { status: 415 });
  const length = req.headers?.['content-length'];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_BODY)) throw Object.assign(new Error('设置请求过大。'), { status: 413 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) throw Object.assign(new Error('设置请求过大。'), { status: 413 });
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('设置请求不是有效 JSON。'), { status: 400 }); }
}

export function preferencesHandler(store, authorize) {
  return async function handler(req, res) {
    if (!authorize(req, res)) return;
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' || method === 'HEAD') return respond(res, 200, { ...await store.read(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, method);
      if (method !== 'PUT') return respond(res, 405, { error: '仅允许 GET、HEAD、PUT。' }, method);
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'patch' && key !== 'revision')) {
        return respond(res, 400, { error: '设置请求格式无效。' }, method);
      }
      return respond(res, 200, { ...await store.update(body.patch, body.revision), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, method);
    } catch (error) {
      const status = [400, 409, 413, 415, 503].includes(error.status) ? error.status : 503;
      const message = status === 409 ? '设置已更改，请重新读取。' : status === 503 ? '设置文件不可用，未覆盖原文件。' : status === 400 ? '设置值无效，请检查范围和时间格式。' : error.message;
      respond(res, status, { error: message }, method);
    }
  };
}
