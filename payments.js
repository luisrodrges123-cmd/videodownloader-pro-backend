import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requiredAuth } from "./auth.js";
import { pool } from "./db.js";

const router = Router();
const PRICE = 29;
const CURRENCY = "MXN";
const APP_URL = process.env.PUBLIC_APP_URL || "https://luisrodrges123-cmd.github.io/videodownloader-pro-backend/";

function mpHeaders() {
  if (!process.env.MP_ACCESS_TOKEN) throw new Error("Falta MP_ACCESS_TOKEN en Render.");
  return { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`, "Content-Type": "application/json" };
}
async function mpRequest(path, options = {}) {
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    ...options, headers: { ...mpHeaders(), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Mercado Pago respondió ${response.status}`);
  return data;
}
function validEmail(value) {
  return typeof value === "string" && value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
function verifyWebhook(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  const signature = req.get("x-signature") || "";
  const requestId = req.get("x-request-id") || "";
  const dataId = String(req.query["data.id"] || req.query.id || "").toLowerCase();
  if (!secret || !signature || !requestId || !dataId) return false;

  const parts = Object.fromEntries(signature.split(",").map(p => {
    const i = p.trim().indexOf("=");
    return i < 0 ? ["", ""] : [p.trim().slice(0, i), p.trim().slice(i + 1)];
  }));
  if (!parts.ts || !parts.v1 || !/^\d+$/.test(parts.ts)) return false;
  const timestamp = Number(parts.ts);
  if (Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) return false;

  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;
  const digest = createHmac("sha256", secret).update(manifest).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

router.post("/subscribe", requiredAuth, async (req, res) => {
  try {
    const email = String(req.body?.payer_email || "").trim().toLowerCase();
    if (!validEmail(email)) return res.status(400).json({ ok:false, error:"Escribe un correo electrónico válido." });

    const existing = await pool.query(
      `SELECT subscription_status, subscription_expires_at FROM users WHERE id=$1`, [req.user.id]
    );
    if (existing.rows[0]?.subscription_status === "authorized" &&
        (!existing.rows[0].subscription_expires_at || new Date(existing.rows[0].subscription_expires_at) > new Date())) {
      return res.status(409).json({ ok:false, error:"Tu suscripción ya está activa." });
    }

    const preference = await mpRequest("/preapproval", {
      method: "POST",
      body: JSON.stringify({
        reason: "VDownloader Pro - suscripción mensual",
        external_reference: `vdp_user_${req.user.id}`,
        payer_email: email,
        auto_recurring: {
          frequency: 1, frequency_type: "months",
          transaction_amount: PRICE, currency_id: CURRENCY
        },
        back_url: `${APP_URL}?subscription=return`,
        status: "pending"
      })
    });

    await pool.query("UPDATE users SET payer_email=$1, mp_subscription_id=$2 WHERE id=$3",
      [email, preference.id, req.user.id]);

    return res.status(201).json({
      ok:true, initPoint: preference.init_point, subscriptionId: preference.id,
      price: PRICE, currency: CURRENCY
    });
  } catch (error) {
    console.error("Create Mercado Pago subscription:", error.message);
    return res.status(502).json({ ok:false, error:"No se pudo iniciar la suscripción. Revisa la configuración de Mercado Pago." });
  }
});

router.get("/status", requiredAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT free_downloads_used, payer_email, subscription_status, subscription_expires_at
      FROM users WHERE id=$1
    `, [req.user.id]);
    const u = result.rows[0];
    const active = u.subscription_status === "authorized" &&
      (!u.subscription_expires_at || new Date(u.subscription_expires_at) > new Date());
    return res.json({
      ok:true, freeDownloadsUsed:u.free_downloads_used,
      freeDownloadsRemaining:active ? null : Math.max(0,5-u.free_downloads_used),
      subscriptionActive:active, subscriptionStatus:u.subscription_status,
      subscriptionExpiresAt:u.subscription_expires_at, price:PRICE, currency:CURRENCY
    });
  } catch (error) {
    console.error("Subscription status:", error.message);
    return res.status(503).json({ ok:false, error:"No se pudo consultar tu suscripción." });
  }
});

router.post("/webhook", async (req, res) => {
  try {
    if (!verifyWebhook(req)) return res.status(401).json({ ok:false, error:"Firma de webhook inválida." });
    const topic = String(req.query.type || req.query.topic || req.body?.type || "");
    const id = String(req.query["data.id"] || req.query.id || req.body?.data?.id || "");
    if (!id || !["subscription_preapproval","preapproval"].includes(topic)) return res.sendStatus(200);

    const sub = await mpRequest(`/preapproval/${encodeURIComponent(id)}`);
    const match = String(sub.external_reference || "").match(/^vdp_user_(\d+)$/);
    if (!match) return res.sendStatus(200);
    const userId = Number(match[1]);

    // Verify amount/currency as well as the user reference; never trust webhook body.
    const correctPlan = Number(sub.auto_recurring?.transaction_amount) === PRICE &&
      sub.auto_recurring?.currency_id === CURRENCY &&
      Number(sub.auto_recurring?.frequency) === 1 &&
      sub.auto_recurring?.frequency_type === "months";
    if (!correctPlan) return res.status(400).json({ ok:false, error:"El plan notificado no coincide." });

    const eventKey = `preapproval:${sub.id}:${sub.status}:${sub.next_payment_date || ""}`;
    const inserted = await pool.query(
      "INSERT INTO mp_webhook_events(event_key) VALUES($1) ON CONFLICT DO NOTHING RETURNING id", [eventKey]
    );
    if (!inserted.rowCount) return res.sendStatus(200);

    const status = String(sub.status || "pending").toLowerCase();
    const expiry = sub.next_payment_date ? new Date(sub.next_payment_date) : null;
    await pool.query(`
      UPDATE users SET
        mp_subscription_id=$1,
        payer_email=COALESCE($2,payer_email),
        subscription_status=$3,
        subscription_expires_at=$4
      WHERE id=$5
    `, [String(sub.id), sub.payer_email || null, status, expiry, userId]);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Mercado Pago webhook:", error.message);
    return res.status(500).json({ ok:false });
  }
});

router.post("/cancel", requiredAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT mp_subscription_id FROM users WHERE id=$1", [req.user.id]);
    const id = result.rows[0]?.mp_subscription_id;
    if (!id) return res.status(404).json({ ok:false, error:"No tienes una suscripción registrada." });
    const sub = await mpRequest(`/preapproval/${encodeURIComponent(id)}`, {
      method:"PUT", body:JSON.stringify({status:"cancelled"})
    });
    await pool.query("UPDATE users SET subscription_status=$1 WHERE id=$2", [sub.status || "cancelled", req.user.id]);
    return res.json({ok:true, status:sub.status});
  } catch (error) {
    console.error("Cancel subscription:", error.message);
    return res.status(502).json({ok:false,error:"No se pudo cancelar la suscripción."});
  }
});

export default router;
