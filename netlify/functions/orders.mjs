// Admin only. GET /api/orders → newest 100 orders · POST {key, status} → update status
import { ordersStore, isAdmin, json } from "../lib/shop.mjs";
const STATUSES = ["new", "confirmed", "done", "cancelled"];

export default async (req) => {
  if (!isAdmin(req)) return json({ error: "unauthorised" }, 401);
  const store = ordersStore();
  if (req.method === "GET") {
    const { blobs } = await store.list();
    const keys = blobs.map((x) => x.key).sort().reverse().slice(0, 100);
    const orders = (await Promise.all(keys.map(async (key) => ({ key, ...(await store.get(key, { type: "json" })) })))).filter((o) => o.ref);
    return json({ orders });
  }
  if (req.method === "POST") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
    if (!STATUSES.includes(b.status) || typeof b.key !== "string") return json({ error: "invalid" }, 400);
    const o = await store.get(b.key, { type: "json" });
    if (!o) return json({ error: "not_found" }, 404);
    o.status = b.status;
    await store.setJSON(b.key, o);
    return json({ ok: true });
  }
  return json({ error: "method" }, 405);
};

export const config = { path: "/api/orders" };
