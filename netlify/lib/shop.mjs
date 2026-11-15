// Shared server logic: catalogue, pricing, stock, auth, email.
// Prices live here so the browser can never change what an order costs.
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

export const COLORS = { black: "Black", silver: "Silver" };
export const PRODUCTS = {
  pegs:  { name: "Prickly Foot Pegs",          price: 200 },
  plate: { name: "Titanium Bolt Vented Plate", price: 180 },
  locks: { name: "Sur-Ron LBX Shift Locks",    price: 120 },
};
export const FEE = 15;

const DEALS = [
  { k: "pair",  t: "2 shift locks for AED 200",              save: 40 },
  { k: "pegs",  t: "Shift locks + foot pegs for AED 300",    save: 20 },
  { k: "plate", t: "Shift locks + vented plate for AED 280", save: 20 },
];

export const money = (n) => "AED " + Number(n).toLocaleString("en-US");

export function bestDeals(cnt) {
  const L = cnt.locks || 0, Pg = cnt.pegs || 0, V = cnt.plate || 0;
  let c = Math.min(L, Pg + V);
  if ((L - c) % 2 && c > 0) c--;
  const pp = Math.min(c, Pg);
  const n = { pair: Math.floor((L - c) / 2), pegs: pp, plate: c - pp };
  return DEALS.filter((d) => n[d.k]).map((d) => ({ t: d.t, n: n[d.k], save: d.save * n[d.k] }));
}

// items: [{id, c, q}] already validated
export function priceOrder(items, method) {
  const lines = items.map((it) => ({
    id: it.id, c: it.c, q: it.q,
    name: PRODUCTS[it.id].name, finish: COLORS[it.c],
    unit: PRODUCTS[it.id].price, total: PRODUCTS[it.id].price * it.q,
  }));
  const counts = {};
  lines.forEach((l) => { counts[l.id] = (counts[l.id] || 0) + l.q; });
  const deals = bestDeals(counts);
  const subtotal = lines.reduce((a, l) => a + l.total, 0);
  const savings = deals.reduce((a, d) => a + d.save, 0);
  const fee = method === "delivery" ? FEE : 0;
  return { lines, deals, subtotal, savings, fee, total: subtotal - savings + fee };
}

// ---------- stock ----------
export const DEFAULT_STOCK = Object.fromEntries(
  Object.keys(PRODUCTS).map((id) => [id, { black: true, silver: true }])
);
const shopStore = () => getStore({ name: "nova-shop", consistency: "strong" });
export const ordersStore = () => getStore({ name: "nova-orders", consistency: "strong" });

export async function readStock() {
  const s = await shopStore().get("stock", { type: "json" });
  const out = structuredClone(DEFAULT_STOCK);
  if (s) for (const id of Object.keys(out)) for (const c of Object.keys(COLORS)) {
    if (s[id] && typeof s[id][c] === "boolean") out[id][c] = s[id][c];
  }
  return out;
}
export async function writeStock(next) {
  const clean = structuredClone(DEFAULT_STOCK);
  for (const id of Object.keys(clean)) for (const c of Object.keys(COLORS)) {
    if (next && next[id] && typeof next[id][c] === "boolean") clean[id][c] = next[id][c];
  }
  await shopStore().setJSON("stock", clean);
  return clean;
}

// ---------- admin auth ----------
const digest = (s) => createHash("sha256").update(String(s)).digest();
export function isAdmin(req) {
  const want = process.env.ADMIN_PASSWORD;
  const got = req.headers.get("x-admin-key") || "";
  if (!want || !got) return false;
  return timingSafeEqual(digest(want), digest(got));
}

// ---------- helpers ----------
export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// ---------- email (Resend). Skipped quietly until RESEND_API_KEY is set ----------
export async function sendMail({ to, subject, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || "NOVA.EMOTO <orders@nova-emoto.com>",
        to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!r.ok) console.error("email failed", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("email error", e);
    return false;
  }
}

export function receiptHTML(o, forOwner) {
  const row = (l, r, strong) => `<tr><td style="padding:8px 0;border-bottom:1px solid #e6e8ec;${strong ? "font-weight:700;font-size:16px" : ""}">${l}</td><td style="padding:8px 0;border-bottom:1px solid #e6e8ec;text-align:right;${strong ? "font-weight:700;font-size:16px" : ""}">${r}</td></tr>`;
  const lines = o.lines.map((l) => row(`${l.q} × ${esc(l.name)} <span style="color:#6b7280">(${esc(l.finish)})</span>`, money(l.total))).join("");
  const deals = o.deals.map((d) => row(`<span style="color:#3D6BFF">Deal: ${esc(d.t)}${d.n > 1 ? " ×" + d.n : ""}</span>`, `<span style="color:#3D6BFF">−${money(d.save)}</span>`)).join("");
  const addr = o.method === "delivery"
    ? `${esc(o.address.unit)}, ${esc(o.address.bld)}, ${esc(o.address.street)}, ${esc(o.address.area)}, Dubai${o.address.land ? "<br>Landmark: " + esc(o.address.land) : ""}`
    : "Collection (we'll send you the pickup spot on WhatsApp)";
  const intro = forOwner
    ? `<p style="margin:0 0 16px">New order from <b>${esc(o.customer.name)}</b>. Message them on WhatsApp to confirm: <a href="https://wa.me/971${esc(o.customer.phone)}">+971 ${esc(o.customer.phone)}</a></p>`
    : `<p style="margin:0 0 16px">Hi ${esc(o.customer.name)}, thanks for your order! We'll message you on WhatsApp at <b>+971 ${esc(o.customer.phone)}</b> to confirm stock, delivery and payment. Nothing has been charged yet.</p>`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0A0C10">
  <div style="background:#0A0C10;color:#fff;padding:18px 22px;font-weight:900;letter-spacing:.04em;font-size:20px">NOVA.EMOTO</div>
  <div style="padding:22px;border:1px solid #e6e8ec;border-top:0">
    <p style="margin:0 0 6px;color:#3D6BFF;font-size:12px;letter-spacing:.12em;text-transform:uppercase">Order ${esc(o.ref)}</p>
    <h1 style="margin:0 0 14px;font-size:24px">${forOwner ? "New order" : "Order received"}</h1>
    ${intro}
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${lines}
      ${row("1 × NOVA keychain", "Free")}
      ${deals}
      ${row("Subtotal", money(o.subtotal))}
      ${o.savings ? row("Bundle savings", "−" + money(o.savings)) : ""}
      ${row("Delivery", o.fee ? money(o.fee) : "Free (collection)")}
      ${row("Total", money(o.total), true)}
    </table>
    <p style="margin:18px 0 4px;font-weight:700">${o.method === "delivery" ? "Deliver to" : "Collection"}</p>
    <p style="margin:0;color:#374151">${addr}</p>
    ${o.note ? `<p style="margin:14px 0 4px;font-weight:700">Notes</p><p style="margin:0;color:#374151">${esc(o.note)}</p>` : ""}
    ${forOwner ? `<p style="margin:14px 0 0;color:#374151">Email: ${esc(o.customer.email)}</p>` : `<p style="margin:22px 0 0;color:#6b7280;font-size:12px">Questions? Reply to this email or message us on WhatsApp. Returns and terms: nova-emoto.com/terms.html</p>`}
  </div></div>`;
}
