// server/lib/http-form.mjs
//
// The shared urlencoded-form intake primitives for every HTML/form surface the
// server exposes: the body-size cap, the content-type predicate, and the
// capped, drain-don't-destroy body reader.
//
// Lifted VERBATIM (behaviour-identical) out of server/lib/oauth/endpoints.mjs
// (`MAX_FORM_BYTES` :39, `isFormContentType` :128-131, `readForm` :73-93) in
// Stage-B task U3. They were module-PRIVATE there, so the /control routes had
// exactly two options: re-implement the cap + parser (a second, divergable
// definition of "how big is too big" and "what counts as a form"), or lift.
// The spec pins reuse (plan U3 / R2-C-N3), and a shared module is the better
// half of that instruction: `endpoints.mjs` is the OAuth *handler factory*, and
// re-exporting request-intake primitives from it would make every future form
// surface import the OAuth module to parse a form.
//
// PURE + dependency-free: no state, no env reads, no logging. `readForm` is the
// only I/O and it only consumes the request stream it is handed.
//
// Callers: server/lib/oauth/endpoints.mjs (consent POST, IdP login POST, token
// POST, DCR body cap) and server/lib/control-routes.mjs (unlock + logout).

// Body-size cap shared by every form/JSON intake path. 64 KiB is far above any
// legitimate form post here (a token paste plus a CSRF token) and far below a
// memory-pressure concern.
export const MAX_FORM_BYTES = 64 * 1024;

// True only for `application/x-www-form-urlencoded` (parameters such as
// `; charset=UTF-8` are permitted and ignored). Anything else — including an
// absent header — is false, so a caller that gates on this is default-closed.
export function isFormContentType(req) {
  const ct = req.headers['content-type'] ?? '';
  return ct.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

// Collect a urlencoded body, capped at MAX_FORM_BYTES, into a URLSearchParams.
// Resolves { params } on success, { tooLarge: true } if the cap is exceeded.
//
// Resolve on `end` whether or not the cap tripped — draining (rather than
// destroying) the socket lets the handler still deliver a clean 400 instead of
// resetting the connection; the cap already bounds buffered bytes.
export function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooLarge = false, settled = false;
    req.on('data', (c) => {
      if (tooLarge) return; // past the cap: drop further chunks, keep draining
      size += c.length;
      if (size > MAX_FORM_BYTES) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return; settled = true;
      if (tooLarge) return resolve({ tooLarge: true });
      resolve({ params: new URLSearchParams(Buffer.concat(chunks).toString('utf8')) });
    });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}
