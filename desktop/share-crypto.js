const encoder = new TextEncoder();
const decoder = new TextDecoder();
const context = encoder.encode("PeopleDo share v1");

export function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let string = "";
  for (let i = 0; i < bytes.length; i += 8_192) {
    string += String.fromCharCode(...bytes.subarray(i, i + 8_192));
  }
  return btoa(string).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unbase64(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Неверный формат ссылки.");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
}

export const newCode = (length = 32) => base64(crypto.getRandomValues(new Uint8Array(length)));

async function derive(code, salt) {
  const secret = await crypto.subtle.importKey("raw", unbase64(code.trim()), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: context }, secret,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export async function seal(text, code) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(code, salt);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context }, key, encoder.encode(text));
  return { salt: base64(salt), iv: base64(iv), data: base64(data) };
}

export async function openEnvelope(envelope, code) {
  const key = await derive(code, unbase64(envelope.salt));
  const result = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: unbase64(envelope.iv), additionalData: context,
  }, key, unbase64(envelope.data));
  return decoder.decode(result);
}
