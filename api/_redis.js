/* Minimal RESP2 client over a raw TCP/TLS socket — no npm dependency, works
   in a Vercel Node.js serverless function. Talks to Vercel's native "Redis"
   product, whose only secret is REDIS_URL (redis://user:pass@host:port or
   rediss://... for TLS) — there is no REST API for it, unlike the older
   Upstash marketplace product this file used to require.
   One TCP connection per call, closed as soon as every reply for that
   pipeline is in. Fine at this app's call volume (a sync every ~45s per open
   tab, a daily cron, on-demand actions) and keeps functions stateless. */
const net = require('net');
const tls = require('tls');

function parseUrl(u) {
  const m = String(u || '').match(/^(rediss?):\/\/(?:([^:@]*):([^@]*)@)?([^:/?]+):(\d+)/);
  if (!m) throw new Error('bad REDIS_URL');
  return { secure: m[1] === 'rediss', user: m[2] || '', pass: m[3] || '', host: m[4], port: Number(m[5]) };
}

function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) { const s = String(a); out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
  return out;
}

/* Parses one RESP2 value starting at buf[off]. Returns {value,next,isError}
   or null if the buffer does not yet hold a complete value. */
function tryParse(buf, off) {
  if (off >= buf.length) return null;
  const type = buf[off];
  const lineEnd = buf.indexOf('\r\n', off);
  if (lineEnd === -1) return null;
  const line = buf.toString('latin1', off + 1, lineEnd);
  const next0 = lineEnd + 2;
  if (type === 0x2b) return { value: line, next: next0 };                 // +simple string
  if (type === 0x2d) return { value: line, next: next0, isError: true };  // -error
  if (type === 0x3a) return { value: parseInt(line, 10), next: next0 };   // :integer
  if (type === 0x24) {                                                    // $bulk string
    const len = parseInt(line, 10);
    if (len === -1) return { value: null, next: next0 };
    if (buf.length < next0 + len + 2) return null;
    return { value: buf.toString('utf8', next0, next0 + len), next: next0 + len + 2 };
  }
  if (type === 0x2a) {                                                    // *array
    const n = parseInt(line, 10);
    if (n === -1) return { value: null, next: next0 };
    let off2 = next0, arr = [];
    for (let i = 0; i < n; i++) {
      const r = tryParse(buf, off2);
      if (!r) return null;
      if (r.isError) return { value: new Error(r.value), next: r.next, isError: true };
      arr.push(r.value); off2 = r.next;
    }
    return { value: arr, next: off2 };
  }
  throw new Error('unexpected RESP type byte ' + type);
}

/* Runs a pipeline of commands against REDIS_URL and resolves to one result
   per command, in order — matching what the rest of the app expects
   (the same shape the old Upstash REST pipeline returned). Throws if any
   command in the pipeline errored. */
function pipe(url, cmds, timeoutMs) {
  const { secure, user, pass, host, port } = parseUrl(url);
  return new Promise((resolve, reject) => {
    const sock = (secure ? tls : net).connect({ host, port });
    let buf = Buffer.alloc(0);
    const results = [];
    let expected = cmds.length + (pass ? 1 : 0);
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch (e) {} fn(arg); };
    const timer = setTimeout(() => finish(reject, new Error('Redis timed out')), timeoutMs || 8000);

    sock.once(secure ? 'secureConnect' : 'connect', () => {
      let out = '';
      if (pass) out += encode(user ? ['AUTH', user, pass] : ['AUTH', pass]);
      for (const c of cmds) out += encode(c);
      sock.write(out);
    });
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      let off = 0;
      while (results.length < expected) {
        const r = tryParse(buf, off);
        if (!r) break;
        off = r.next;
        results.push(r);
      }
      buf = buf.slice(off);
      if (results.length >= expected) {
        const cmdResults = pass ? results.slice(1) : results;
        const bad = cmdResults.find(r => r.isError);
        if (bad) return finish(reject, new Error('Redis: ' + bad.value));
        const authBad = pass && results[0] && results[0].isError;
        if (authBad) return finish(reject, new Error('Redis auth failed: ' + results[0].value));
        finish(resolve, cmdResults.map(r => r.value));
      }
    });
    sock.on('error', e => finish(reject, e));
    sock.on('close', () => { if (!done) finish(reject, new Error('Redis connection closed early')); });
  });
}

module.exports = { pipe, parseUrl, encode, tryParse };
