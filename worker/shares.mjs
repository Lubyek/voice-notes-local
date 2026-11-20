import cryptoModule from "./share-crypto-source.mjs";

const notePattern = /^\/note\/([0-9a-f-]{36})$/i;
const dataPattern = /^\/note-data\/([0-9a-f-]{36})$/i;
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const codePattern = /^[A-Za-z0-9_-]{43}$/;
const expiration = 30 * 24 * 60 * 60;

const privacy = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const viewer = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PeopleDo · Заметка встречи</title><style>
:root{font:16px/1.6 system-ui,sans-serif;color:#193029;background:#f3f7f4}
main{max-width:750px;margin:5vh auto;background:#fff;border:1px solid #dce7e0;border-radius:14px;padding:clamp(18px,5vw,38px)}
h1{margin:0;color:#146641}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
input,button{font:inherit;padding:7px 9px;border-radius:7px;border:1px solid #cadbd1}
button{background:#146641;color:white;cursor:pointer}label{display:block}form{margin:15px 0}
</style></head><body><main><h1>PeopleDo</h1><p id="status" role="status">Открываем заметку…</p>
<form id="access" hidden><label for="code">Код доступа</label><input id="code" type="password" required autocomplete="off">
<button type="submit">Открыть</button></form><pre id="note"></pre></main><script type="module" src="/note-view.js"></script></body></html>`;

const script = `import { openEnvelope } from "/note-crypto.js";
const status = document.getElementById("status");
const form = document.getElementById("access");
const code = document.getElementById("code");
const note = document.getElementById("note");
const fragment = location.hash.slice(1);
try {
  const response = await fetch("/note-data/" + location.pathname.split("/").pop(), { credentials: "omit" });
  if (!response.ok) throw new Error("Заметку удалили или срок ссылки истёк.");
  const envelope = await response.json();
  async function show(value) {
    try {
      note.textContent = await openEnvelope(envelope, value);
      form.hidden = true;
      code.value = "";
      status.textContent = "";
    } catch {
      status.textContent = "Не удалось открыть заметку. Проверь код доступа или скопируй исходную ссылку целиком.";
      form.hidden = false;
    }
  }
  form.onsubmit = (event) => { event.preventDefault(); void show(code.value); };
  if (fragment) await show(fragment);
  else { status.textContent = "Для этой заметки нужен код доступа."; form.hidden = false; }
} catch (error) { status.textContent = error.message; }`;

export async function sharedPage(path, env) {
  if (path === "/note-view.js" || path === "/note-crypto.js") {
    return new Response(path === "/note-view.js" ? script : cryptoModule,
      { headers: { ...privacy, "Content-Type": "text/javascript; charset=utf-8" } });
  }
  if (notePattern.test(path)) return new Response(viewer, { headers: { ...privacy, "Content-Type": "text/html; charset=utf-8" } });
  const id = dataPattern.exec(path)?.[1];
  if (!id) return null;
  try {
    const stored = await env.SHARES?.get("note:" + id, { type: "json", cacheTtl: 30 });
    return stored ? Response.json(stored.envelope, { headers: privacy }) : new Response(null, { status: 404, headers: privacy });
  } catch { return new Response(null, { status: 503, headers: privacy }); }
}

async function hash(code) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function updateShare(path, request, env, headers) {
  const fail = (error, status) => Response.json({ error }, { headers, status });
  if (!env.SHARES) return fail("Хранилище ссылок недоступно.", 503);
  const length = Number(request.headers.get("content-length"));
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json"
      || !Number.isInteger(length) || length < 1 || length > 550_000) return fail("Некорректный размер запроса.", 400);
  let input;
  try { input = await request.json(); } catch { return fail("Некорректный запрос.", 400); }
  const { token, id, envelope } = input ?? {};
  if (typeof token !== "string" || !codePattern.test(token)) return fail("Неверный ключ управления.", 400);

  if (path === "/shares/revoke") {
    if (typeof id !== "string" || !idPattern.test(id)) return fail("Неверный идентификатор ссылки.", 400);
    const key = "note:" + id;
    const existing = await env.SHARES.get(key, { type: "json", cacheTtl: 30 });
    if (!existing) return Response.json({ ok: true }, { headers });
    const a = new TextEncoder().encode(existing.owner);
    const b = new TextEncoder().encode(await hash(token));
    if (a.length !== b.length || !crypto.subtle.timingSafeEqual(a, b)) return fail("Недостаточно прав для отзыва ссылки.", 403);
    await env.SHARES.delete(key);
    return Response.json({ ok: true }, { headers });
  }
  if (!envelope || !/^[A-Za-z0-9_-]{22}$/.test(envelope.salt) || !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv)
      || typeof envelope.data !== "string" || !/^[A-Za-z0-9_-]{24,540000}$/.test(envelope.data)) {
    return fail("Ожидается зашифрованная заметка.", 400);
  }
  const noteId = crypto.randomUUID();
  await env.SHARES.put("note:" + noteId, JSON.stringify({
    owner: await hash(token), envelope: { salt: envelope.salt, iv: envelope.iv, data: envelope.data },
  }), { expirationTtl: expiration });
  return Response.json({ id: noteId, expiresAt: Date.now() + expiration * 1000 }, { headers, status: 201 });
}
