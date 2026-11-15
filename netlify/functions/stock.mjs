// GET /api/stock (public) · POST /api/stock (admin) {stock:{pegs:{black:true,silver:false},...}}
import { readStock, writeStock, isAdmin, json } from "../lib/shop.mjs";

export default async (req) => {
  if (req.method === "GET") return json(await readStock());
  if (req.method === "POST") {
    if (!isAdmin(req)) return json({ error: "unauthorised" }, 401);
    let b; try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
    return json(await writeStock(b.stock));
  }
  return json({ error: "method" }, 405);
};

export const config = { path: "/api/stock" };
