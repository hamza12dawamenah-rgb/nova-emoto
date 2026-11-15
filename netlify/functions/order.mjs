// POST /api/order : validate, re-price on the server, check stock, save, email receipt + owner alert
import { PRODUCTS, COLORS, priceOrder, readStock, ordersStore, json, sendMail, receiptHTML } from "../lib/shop.mjs";

const clip = (s, n) => String(s ?? "").trim().slice(0, n);

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  if (b.company) return json({ ok: true, ref: "NE-00000" }); // honeypot: bots fill hidden fields

  const name = clip(b.name, 80), email = clip(b.email, 120).toLowerCase();
  const phone = String(b.phone ?? "").replace(/\D/g, "").replace(/^971/, "").replace(/^0+/, "");
  const method = b.method === "pickup" ? "pickup" : "delivery";
  const a = b.address || {};
  const address = { area: clip(a.area, 80), street: clip(a.street, 80), bld: clip(a.bld, 80), unit: clip(a.unit, 40), land: clip(a.land, 120) };
  const note = clip(b.note, 500);

  const bad = [];
  if (name.length < 2) bad.push("name");
  if (phone.length < 8 || phone.length > 9) bad.push("phone");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) bad.push("email");
  if (method === "delivery") {
    if (address.area.length < 2) bad.push("area");
    if (address.street.length < 1) bad.push("street");
    if (address.bld.length < 2) bad.push("bld");
    if (address.unit.length < 1) bad.push("unit");
  }
  const merged = {};
  for (const it of Array.isArray(b.items) ? b.items.slice(0, 20) : []) {
    const q = Math.floor(Number(it.q));
    if (!PRODUCTS[it.id] || !COLORS[it.c] || !(q >= 1 && q <= 20)) continue;
    const k = it.id + "|" + it.c;
    merged[k] = Math.min(20, (merged[k] || 0) + q);
  }
  const items = Object.entries(merged).map(([k, q]) => { const [id, c] = k.split("|"); return { id, c, q }; });
  if (!items.length) bad.push("items");
  if (bad.length) return json({ error: "invalid", fields: bad }, 400);

  const stock = await readStock();
  const sold = items.filter((it) => stock[it.id][it.c] === false).map((it) => it.id + "|" + it.c);
  if (sold.length) return json({ error: "out_of_stock", items: sold, stock }, 409);

  const priced = priceOrder(items, method);
  const now = Date.now();
  const ref = "NE-" + now.toString(36).toUpperCase().slice(-4) + Math.random().toString(36).slice(2, 4).toUpperCase();
  const order = { ref, createdAt: new Date(now).toISOString(), status: "new", customer: { name, phone, email }, method, address: method === "delivery" ? address : null, note, ...priced };
  await ordersStore().setJSON(now + "-" + ref, order);

  const owner = process.env.OWNER_EMAIL;
  const [toCustomer] = await Promise.all([
    sendMail({ to: email, subject: `Your NOVA.EMOTO order ${ref}`, html: receiptHTML(order, false), replyTo: owner }),
    sendMail({ to: owner, subject: `New order ${ref} · ${name} · AED ${order.total}`, html: receiptHTML(order, true), replyTo: email }),
  ]);
  return json({ ok: true, ref, total: order.total, emailed: toCustomer });
};

export const config = { path: "/api/order" };
