import { Router } from "express";
import { createVerify, randomUUID } from "node:crypto";
import { requiredAuth } from "./auth.js";
import { pool } from "./db.js";
import { logAdminEvent } from "./events.js";

const router = Router();
const PRICE_MXN = 29;
const AMOUNT_CENTS = 2900;
const CURRENCY = "MXN";
const APP_URL = process.env.PUBLIC_APP_URL || "https://luisrodrges123-cmd.github.io/videodownloader-pro-backend/";

function conektaHeaders(extra = {}) {
  const key = process.env.CONEKTA_PRIVATE_KEY;
  if (!key) throw new Error("Falta CONEKTA_PRIVATE_KEY en Render.");
  return {
    Authorization: `Bearer ${key}`,
    accept: "application/vnd.conekta-v2.3.0+json",
    "content-type": "application/json",
    "Accept-Language": "es",
    ...extra
  };
}

async function conektaRequest(path, options = {}) {
  const response = await fetch(`https://api.conekta.io${path}`, {
    ...options,
    headers: conektaHeaders(options.headers || {}),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.details?.[0]?.message || data.message || data.object || `Conekta respondió ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function validEmail(value) {
  return typeof value === "string" && value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function validPhone(value) {
  return typeof value === "string" && /^\+?\d{10,15}$/.test(value.replace(/[\s()-]/g, ""));
}

function verifyWebhook(req) {
  const pem = process.env.CONEKTA_WEBHOOK_PUBLIC_KEY;
  const raw = req.rawBody;
  const digest = req.get("digest");
  if (!pem || !raw || !digest) return false;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(raw);
    verifier.end();
    return verifier.verify(pem, Buffer.from(digest.trim(), "base64"));
  } catch {
    return false;
  }
}

router.post("/checkout", requiredAuth, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = String(req.body?.phone || "").trim().replace(/[\s()-]/g, "");
    if (!validEmail(email)) return res.status(400).json({ ok:false, error:"Escribe un correo electrónico válido." });
    if (!validPhone(phone)) return res.status(400).json({ ok:false, error:"Escribe un teléfono con lada de país, por ejemplo +526691234567." });

    const account = await pool.query(`
      SELECT username, display_name, admin_premium_until, subscription_status, subscription_expires_at
      FROM users WHERE id=$1 AND is_blocked=FALSE
    `, [req.user.id]);
    if (!account.rowCount) return res.status(404).json({ ok:false, error:"Cuenta no disponible." });
    const u = account.rows[0];
    const active = (u.admin_premium_until && new Date(u.admin_premium_until) > new Date()) ||
      (u.subscription_status === "authorized" && u.subscription_expires_at && new Date(u.subscription_expires_at) > new Date());
    if (active) return res.status(409).json({ ok:false, error:"Tu cuenta ya tiene Premium activo." });

    const idempotencyKey = randomUUID();
    const order = await conektaRequest("/orders", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        currency: CURRENCY,
        customer_info: {
          name: String(u.display_name || u.username).slice(0, 100),
          email,
          phone
        },
        line_items: [{
          name: "VDownloader Pro Premium - 30 días",
          description: "Acceso Premium durante 30 días",
          quantity: 1,
          unit_price: AMOUNT_CENTS
        }],
        metadata: {
          app: "vdownloader-pro",
          user_id: String(req.user.id),
          plan: "premium_30_days"
        },
        checkout: {
          type: "HostedPayment",
          name: "VDownloader Pro Premium",
          success_url: `${APP_URL}?payment=return`,
          failure_url: `${APP_URL}?payment=failed`
        }
      })
    });

    if (!order.id || !order.checkout?.url) {
      throw new Error("Conekta no devolvió el enlace de pago de la orden.");
    }

    await pool.query(`
      INSERT INTO conekta_orders
        (user_id, order_id, amount, currency, status, checkout_url, payer_email, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (order_id) DO NOTHING
    `, [req.user.id, order.id, AMOUNT_CENTS, CURRENCY, order.payment_status || "pending_payment", order.checkout.url, email]);

    await pool.query("UPDATE users SET payer_email=$1 WHERE id=$2", [email, req.user.id]);
    await logAdminEvent({
      type: "subscription_started", category: "payments", userId: req.user.id,
      username: req.user.username,
      details: `Se creó una orden Conekta por $${PRICE_MXN} MXN. Referencia: ${order.id}.`
    });
    return res.status(201).json({
      ok:true, checkoutUrl:order.checkout.url, orderId:order.id,
      amount:PRICE_MXN, currency:CURRENCY, status:order.payment_status || "pending_payment"
    });
  } catch (error) {
    console.error("Conekta create checkout:", error.message);
    await logAdminEvent({
      type:"payment_error", category:"payments", userId:req.user?.id,
      username:req.user?.username, details:"No se pudo crear la orden de pago Conekta."
    });
    return res.status(502).json({ ok:false, error:"No se pudo iniciar el pago. Revisa la configuración de Conekta e inténtalo de nuevo." });
  }
});

router.get("/status", requiredAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT free_downloads_used, payer_email, admin_premium_until,
             subscription_status, subscription_expires_at
      FROM users WHERE id=$1
    `, [req.user.id]);
    const u = result.rows[0];
    if (!u) return res.status(404).json({ ok:false, error:"Cuenta no encontrada." });
    const adminActive = u.admin_premium_until && new Date(u.admin_premium_until) > new Date();
    const paidActive = u.subscription_status === "authorized" &&
      u.subscription_expires_at && new Date(u.subscription_expires_at) > new Date();
    const active = Boolean(adminActive || paidActive);
    const lastOrder = await pool.query(`
      SELECT order_id, status, amount, currency, created_at, paid_at
      FROM conekta_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1
    `, [req.user.id]);
    return res.json({
      ok:true, freeDownloadsUsed:u.free_downloads_used,
      freeDownloadsRemaining:active ? null : Math.max(0,5-u.free_downloads_used),
      subscriptionActive:active,
      subscriptionStatus:adminActive ? "admin" : u.subscription_status || "none",
      premiumSource:adminActive ? "admin" : paidActive ? "conekta" : null,
      adminPremiumUntil:u.admin_premium_until,
      subscriptionExpiresAt:u.subscription_expires_at,
      lastPayment:lastOrder.rows[0] || null,
      price:PRICE_MXN, currency:CURRENCY
    });
  } catch (error) {
    console.error("Conekta payment status:", error.message);
    return res.status(503).json({ ok:false, error:"No se pudo consultar tu estado de pago." });
  }
});

router.post("/webhook", async (req, res) => {
  try {
    if (!verifyWebhook(req)) return res.status(401).json({ ok:false, error:"Firma de webhook inválida." });
    const event = JSON.parse(req.rawBody.toString("utf8"));
    const eventId = String(event.id || "");
    const eventType = String(event.type || "");
    const object = event.data?.object || {};
    if (!eventId || !eventType) return res.status(400).json({ ok:false });

    if (!["order.paid", "order.pending_payment", "order.declined"].includes(eventType)) {
      return res.sendStatus(200);
    }
    const orderId = String(object.id || object.order_id || "");
    if (!orderId) return res.status(400).json({ ok:false });

    // Nunca activar Premium con el JSON recibido solamente: consultamos la orden en Conekta.
    const order = await conektaRequest(`/orders/${encodeURIComponent(orderId)}`);
    const metadata = order.metadata || {};
    const userId = Number(metadata.user_id);
    if (metadata.app !== "vdownloader-pro" || !Number.isInteger(userId) || userId < 1) {
      return res.status(200).json({ ok:true, ignored:true });
    }
    if (order.currency !== CURRENCY || Number(order.amount) !== AMOUNT_CENTS) {
      console.error("Conekta webhook: importe/moneda no coinciden", orderId);
      return res.status(400).json({ ok:false, error:"Importe o moneda no coinciden." });
    }

    const paid = eventType === "order.paid" && order.payment_status === "paid";
    const paymentStatus = String(order.payment_status || eventType);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const seen = await client.query(`
        INSERT INTO conekta_webhook_events(event_id,event_type)
        VALUES($1,$2) ON CONFLICT(event_id) DO NOTHING RETURNING event_id
      `, [eventId,eventType]);
      if (!seen.rowCount) {
        await client.query("COMMIT");
        return res.sendStatus(200);
      }

      const stored = await client.query(`
        UPDATE conekta_orders SET status=$1, paid_at=CASE WHEN $2 THEN COALESCE(paid_at,NOW()) ELSE paid_at END,
          payment_method=COALESCE($3,payment_method), updated_at=NOW()
        WHERE order_id=$4 AND user_id=$5
        RETURNING id
      `, [paymentStatus, paid, object.charges?.data?.[0]?.payment_method?.object || object.payment_method?.object || null, orderId,userId]);

      if (paid && stored.rowCount) {
        await client.query(`
          UPDATE users SET
            subscription_status='authorized',
            subscription_expires_at=GREATEST(COALESCE(subscription_expires_at,NOW()),NOW()) + INTERVAL '30 days',
            payer_email=COALESCE($1,payer_email)
          WHERE id=$2
        `, [order.customer_info?.email || null,userId]);
      }
      await client.query("COMMIT");

      if (paid && stored.rowCount) {
        const account = await pool.query("SELECT username FROM users WHERE id=$1",[userId]);
        await logAdminEvent({
          type:"subscription_changed", category:"payments", userId,
          username:account.rows[0]?.username,
          details:`Pago Conekta confirmado. Premium extendido 30 días. Orden: ${orderId}.`
        });
      }
      return res.sendStatus(200);
    } catch (error) {
      await client.query("ROLLBACK").catch(()=>{});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Conekta webhook:", error.message);
    return res.status(500).json({ ok:false });
  }
});

export default router;
