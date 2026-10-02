// Cadence — brand application endpoint.
// Receives the website form, emails the application to the team,
// and sends the brand a confirmation with the link to book a call.
// Requires the env var RESEND_API_KEY on the Vercel project.

const TEAM = 'hello@cadenceinfluence.com';
const FROM = 'Louis from Cadence <hello@cadenceinfluence.com>';
const SITE = 'https://www.cadenceinfluence.com';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clip = (s, n = 500) => String(s ?? '').trim().slice(0, n);

async function send(payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return r.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (b.company_site) return res.status(200).json({ ok: true }); // honeypot: silently drop bots

  const d = {
    brand: clip(b.brand, 120), website: clip(b.website, 200), revenue: clip(b.revenue, 40),
    category: clip(b.category, 120), name: clip(b.name, 120), role: clip(b.role, 120),
    email: clip(b.email, 200), message: clip(b.message, 3000), lang: b.lang === 'fr' ? 'fr' : 'en',
  };
  if (!d.brand || !d.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ ok: false, error: 'not_configured' });

  const callUrl = `${SITE}${d.lang === 'fr' ? '/fr/call' : '/call'}`;
  const rows = [
    ['Brand', d.brand], ['Website', d.website], ['Annual revenue', d.revenue], ['Category', d.category],
    ['Name', d.name], ['Role', d.role], ['Email', d.email], ['Message', d.message], ['Language', d.lang],
  ];
  const table = rows.map(([k, v]) => `<tr><td style="padding:6px 14px 6px 0;color:#8A8A9A">${k}</td><td style="padding:6px 0"><b>${esc(v) || '—'}</b></td></tr>`).join('');

  try {
    // 1) Notify the team
    await send({
      from: 'Cadence Applications <hello@cadenceinfluence.com>',
      to: [TEAM],
      reply_to: d.email,
      subject: `New application — ${d.brand} (${d.revenue || 'revenue n/a'})`,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px"><h2 style="margin:0 0 12px">New brand application</h2><table>${table}</table><p style="margin-top:18px;color:#8A8A9A">Reply to this email to answer ${esc(d.name)} directly.</p></div>`,
      text: rows.map(([k, v]) => `${k}: ${v || '—'}`).join('\n'),
    });

    // 2) Confirm to the brand
    const first = esc(d.name.split(' ')[0]);
    const fr = d.lang === 'fr';
    const subject = fr ? `Cadence × ${d.brand} — candidature bien reçue` : `Cadence × ${d.brand} — application received`;
    const html = fr
      ? `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#111">
<p>Bonjour ${first},</p>
<p>Merci pour la candidature de <b>${esc(d.brand)}</b>. Nous l'étudions personnellement et revenons vers vous sous 48 heures.</p>
<p>Pour gagner du temps, vous pouvez réserver dès maintenant un appel de 20 minutes : nous vous y montrerons de vrais créateurs de votre niche.</p>
<p><a href="${callUrl}" style="display:inline-block;background:#C6FF3D;color:#0B0B14;padding:12px 22px;border-radius:99px;text-decoration:none;font-weight:bold">Réserver mon appel →</a></p>
<p>À très vite,<br>Louis — Cadence<br><a href="${SITE}">cadenceinfluence.com</a></p></div>`
      : `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#111">
<p>Hi ${first},</p>
<p>Thanks for applying with <b>${esc(d.brand)}</b>. We review every application personally and will get back to you within 48 hours.</p>
<p>To save time, you can already book a 20-minute call — we'll show you real creators from your niche.</p>
<p><a href="${callUrl}" style="display:inline-block;background:#C6FF3D;color:#0B0B14;padding:12px 22px;border-radius:99px;text-decoration:none;font-weight:bold">Book my call →</a></p>
<p>Talk soon,<br>Louis — Cadence<br><a href="${SITE}">cadenceinfluence.com</a></p></div>`;
    const text = fr
      ? `Bonjour ${d.name.split(' ')[0]},\n\nMerci pour la candidature de ${d.brand}. Réponse sous 48 h.\nRéservez votre appel : ${callUrl}\n\nLouis — Cadence`
      : `Hi ${d.name.split(' ')[0]},\n\nThanks for applying with ${d.brand}. We'll reply within 48 hours.\nBook your call: ${callUrl}\n\nLouis — Cadence`;
    await send({ from: FROM, to: [d.email], reply_to: TEAM, subject, html, text });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ ok: false });
  }
}
