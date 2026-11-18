import { Router } from "express";
import { createHmac, randomUUID, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { requiredAuth } from "./auth.js";
import { pool } from "./db.js";
import { logAdminEvent, sendWhatsAppPurchaseThankYou } from "./events.js";

const router = Router();
const PRICE = 35;
const FREE_DOWNLOAD_LIMIT = 10;
const CURRENCY = "MXN";
const CONEKTA_AMOUNT = PRICE * 100;
const PREMIUM_DAYS = 30;
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
function conektaHeaders() {
  const key = String(process.env.CONEKTA_PRIVATE_KEY || "").trim();
  if (!key) throw new Error("Falta CONEKTA_PRIVATE_KEY en Render.");
  return {
    Authorization: "Bearer " + key,
    Accept: "application/vnd.conekta-v2.3.0+json",
    "Accept-Language": "es",
    "Content-Type": "application/json"
  };
}

async function conektaRequest(path, options = {}) {
  const response = await fetch("https://api.conekta.io" + path, {
    ...options,
    headers: { ...conektaHeaders(), ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.details?.[0]?.message || data.message || data.error || "Conekta respondió " + response.status;
    throw new Error(String(detail).slice(0, 300));
  }
  return data;
}

function verifyConektaWebhook(req) {
  const pem = String(process.env.CONEKTA_WEBHOOK_PUBLIC_KEY || "").trim().replace(/\\n/g, "\n");
  const digest = String(req.get("digest") || "").trim();
  if (!pem || !digest || !Buffer.isBuffer(req.rawBody)) return false;
  try {
    return verifySignature("RSA-SHA256", req.rawBody, pem, Buffer.from(digest, "base64"));
  } catch {
    return false;
  }
}

async function settleConektaOrder(orderId) {
  const stored = await pool.query(
    `SELECT p.order_id, p.user_id, p.expected_amount, p.currency, p.status,
            u.username, u.display_name, u.phone, u.whatsapp_opt_in
     FROM conekta_order_payments p JOIN users u ON u.id=p.user_id WHERE p.order_id=$1`,
    [orderId]
  );
  if (!stored.rowCount) return { status: "unrecognized" };
  const payment = stored.rows[0];
  const order = await conektaRequest("/orders/" + encodeURIComponent(orderId));
  const actualAmount = Number(order.amount ?? order.total);
  if (order.id !== orderId || order.currency !== payment.currency || actualAmount !== Number(payment.expected_amount)) {
    throw new Error("La orden de Conekta no coincide con el importe esperado.");
  }
  if (order.metadata?.user_id && String(order.metadata.user_id) !== String(payment.user_id)) {
    throw new Error("La orden de Conekta no pertenece a esta cuenta.");
  }
  if (String(order.payment_status || "").toLowerCase() !== "paid") {
    return { status: String(order.payment_status || payment.status || "pending").toLowerCase() };
  }

  const client = await pool.connect();
  let activated = false;
  let expiresAt = null;
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT status, user_id FROM conekta_order_payments WHERE order_id=$1 FOR UPDATE",
      [orderId]
    );
    if (!locked.rowCount || Number(locked.rows[0].user_id) !== Number(payment.user_id)) {
      await client.query("ROLLBACK");
      return { status: "unrecognized" };
    }
    if (locked.rows[0].status !== "paid") {
      const updated = await client.query(
        "UPDATE users SET conekta_premium_until=GREATEST(COALESCE(conekta_premium_until,NOW()),NOW()) + ($1::text || ' days')::interval WHERE id=$2 RETURNING conekta_premium_until",
        [PREMIUM_DAYS, payment.user_id]
      );
      if (!updated.rowCount) throw new Error("No se encontró la cuenta asociada al pago.");
      expiresAt = updated.rows[0].conekta_premium_until;
      await client.query("UPDATE conekta_order_payments SET status='paid', paid_at=NOW() WHERE order_id=$1", [orderId]);
      activated = true;
    } else {
      const current = await client.query("SELECT conekta_premium_until FROM users WHERE id=$1", [payment.user_id]);
      expiresAt = current.rows[0]?.conekta_premium_until || null;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (activated) {
    const user = await pool.query("SELECT username FROM users WHERE id=$1", [payment.user_id]);
    await logAdminEvent({
      type: "subscription_changed", category: "payments", userId: payment.user_id,
      username: user.rows[0]?.username,
      details: "Premium de Conekta activado por " + PREMIUM_DAYS + " días."
    });
  }
  let whatsappThanksSent = false;
  let whatsappThanksPending = false;
  if (payment.whatsapp_opt_in && payment.phone) {
    const claim = await pool.query(`
      UPDATE conekta_order_payments
      SET whatsapp_thanks_status='sending', whatsapp_thanks_attempted_at=NOW()
      WHERE order_id=$1 AND (
        whatsapp_thanks_status IN ('pending','failed') OR
        (whatsapp_thanks_status='sending' AND whatsapp_thanks_attempted_at < NOW()-INTERVAL '2 minutes')
      )
      RETURNING order_id
    `, [orderId]);
    if (claim.rowCount) {
      try {
        await sendWhatsAppPurchaseThankYou({
          phone: payment.phone,
          username: payment.display_name || payment.username,
          premiumUntil: expiresAt
        });
        await pool.query(
          "UPDATE conekta_order_payments SET whatsapp_thanks_status='sent', whatsapp_thanks_sent_at=NOW() WHERE order_id=$1",
          [orderId]
        );
        whatsappThanksSent = true;
      } catch (error) {
        console.error("WhatsApp purchase thank-you:", error.message);
        await pool.query("UPDATE conekta_order_payments SET whatsapp_thanks_status='failed' WHERE order_id=$1", [orderId]);
        whatsappThanksPending = true;
      }
    } else {
      const state = await pool.query("SELECT whatsapp_thanks_status FROM conekta_order_payments WHERE order_id=$1", [orderId]);
      whatsappThanksSent = state.rows[0]?.whatsapp_thanks_status === "sent";
      whatsappThanksPending = state.rows[0]?.whatsapp_thanks_status !== "sent";
    }
  }
  return {
    status: "paid", conektaPremiumUntil: expiresAt,
    whatsappThanksSent, whatsappThanksPending,
    whatsappThanksEnabled: Boolean(payment.whatsapp_opt_in && payment.phone)
  };
}

function verifyWebhook(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  const signature = req.get("x-signature") || "";
  const requestId = req.get("x-request-id") || "";
  const dataId = String(req.query["data.id"] || req.query.id || req.body?.data?.id || "").toLowerCase();
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

router.post("/conekta/order", requiredAuth, async (req, res) => {
  try {
    const privateKey = String(process.env.CONEKTA_PRIVATE_KEY || "").trim();
    const publicKey = String(process.env.CONEKTA_PUBLIC_KEY || "").trim();
    const webhookPublicKey = String(process.env.CONEKTA_WEBHOOK_PUBLIC_KEY || "").trim();
    if (!privateKey || !publicKey || !webhookPublicKey) {
      return res.status(503).json({ ok: false, error: "Configura las llaves privada, pública y pública de webhooks de Conekta en Render." });
    }
    const current = await pool.query(
      "SELECT email, payer_email, phone, whatsapp_opt_in, subscription_status, subscription_expires_at, admin_premium_until, conekta_premium_until FROM users WHERE id=$1",
      [req.user.id]
    );
    const user = current.rows[0];
    if (!user) return res.status(404).json({ ok: false, error: "Cuenta no encontrada." });
    const email = String(user.email || user.payer_email || "").trim().toLowerCase();
    if (!validEmail(email)) {
      return res.status(400).json({ ok: false, error: "Agrega un correo válido al perfil de tu cuenta y vuelve a intentarlo. Se usará automáticamente para el pago." });
    }
    const now = Date.now();
    const premiumActive = (user.admin_premium_until && new Date(user.admin_premium_until).getTime() > now) ||
      (user.conekta_premium_until && new Date(user.conekta_premium_until).getTime() > now) ||
      (user.subscription_status === "authorized" &&
        (!user.subscription_expires_at || new Date(user.subscription_expires_at).getTime() > now));
    if (premiumActive) return res.status(409).json({ ok: false, error: "Tu cuenta ya tiene Premium activo." });

    const order = await conektaRequest("/orders", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        currency: CURRENCY,
        customer_info: {
          name: String(req.user.display_name || req.user.username).slice(0, 100),
          email,
          ...(user.phone ? { phone: user.phone } : {})
        },
        line_items: [{
          name: "VDownloader Pro - 30 días",
          description: "Acceso Premium durante 30 días. Renovación manual.",
          unit_price: CONEKTA_AMOUNT,
          quantity: 1
        }],
        checkout: { type: "Integration", name: "VDownloader Pro" },
        metadata: { user_id: String(req.user.id), product: "premium_30_days" }
      })
    });
    if (!order.id || !order.checkout?.id) throw new Error("Conekta no devolvió el identificador del Checkout.");

    await pool.query(
      "INSERT INTO conekta_order_payments (order_id, checkout_id, user_id, expected_amount, currency) VALUES ($1,$2,$3,$4,$5)",
      [String(order.id), String(order.checkout.id), req.user.id, CONEKTA_AMOUNT, CURRENCY]
    );
    await pool.query("UPDATE users SET payer_email=$1 WHERE id=$2", [email, req.user.id]);
    await logAdminEvent({
      type: "subscription_started", category: "payments", userId: req.user.id,
      username: req.user.username, details: "Se inició un pago único de Premium por 30 días con Conekta."
    });
    return res.status(201).json({
      ok: true, orderId: String(order.id), checkoutRequestId: String(order.checkout.id),
      publicKey, amount: PRICE, currency: CURRENCY, days: PREMIUM_DAYS
    });
  } catch (error) {
    await logAdminEvent({
      type: "payment_error", category: "payments", userId: req.user?.id,
      username: req.user?.username, details: "No se pudo iniciar el Checkout de Conekta."
    });
    console.error("Create Conekta order:", error.message);
    return res.status(502).json({ ok: false, error: "No se pudo iniciar el pago con Conekta. Revisa las llaves y los métodos habilitados." });
  }
});

router.post("/conekta/orders/:orderId/verify", requiredAuth, async (req, res) => {
  try {
    const orderId = String(req.params.orderId || "");
    if (!/^ord_[A-Za-z0-9]+$/.test(orderId)) return res.status(400).json({ ok: false, error: "Orden inválida." });
    const owned = await pool.query("SELECT user_id FROM conekta_order_payments WHERE order_id=$1", [orderId]);
    if (!owned.rowCount || Number(owned.rows[0].user_id) !== Number(req.user.id)) {
      return res.status(404).json({ ok: false, error: "No se encontró esa orden." });
    }
    const result = await settleConektaOrder(orderId);
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error("Verify Conekta order:", error.message);
    return res.status(502).json({ ok: false, error: "No se pudo confirmar el pago. Intenta de nuevo en un momento." });
  }
});

router.post("/conekta/webhook", async (req, res) => {
  if (!verifyConektaWebhook(req)) return res.status(401).json({ ok: false, error: "Firma de Conekta inválida." });
  try {
    const event = req.body || {};
    if (event.type !== "order.paid") return res.sendStatus(200);
    const orderId = String(event.data?.object?.id || "");
    if (!/^ord_[A-Za-z0-9]+$/.test(orderId)) return res.sendStatus(200);
    const settled = await settleConektaOrder(orderId);
    if (settled.whatsappThanksPending) return res.status(503).json({ ok: false, error: "El pago quedó confirmado, pero WhatsApp no aceptó el agradecimiento; Conekta volverá a intentar la notificación." });
    return res.sendStatus(200);
  } catch (error) {
    console.error("Conekta webhook:", error.message);
    return res.status(500).json({ ok: false });
  }
});

router.post("/subscribe", requiredAuth, (_req, res) => {
  return res.status(410).json({
    ok: false,
    error: "Las nuevas suscripciones se procesan únicamente con Conekta."
  });
});

router.get("/status", requiredAuth, async (req, res) => {
  try {
    // Consultar Mercado Pago al volver del checkout y al abrir la cuenta.
    // Así no dependemos exclusivamente del tiempo de entrega del webhook.
    const result = await pool.query(`
      SELECT free_downloads_used, payer_email, mp_subscription_id, admin_premium_until,
             subscription_status, subscription_expires_at, conekta_premium_until
      FROM users WHERE id=$1
    `, [req.user.id]);
    const u = result.rows[0];
    if (!u) return res.status(404).json({ ok:false, error:"Cuenta no encontrada." });

    let status = u.subscription_status || "none";
    let expiresAt = u.subscription_expires_at;
    if (u.mp_subscription_id && process.env.MP_ACCESS_TOKEN) {
      try {
        const sub = await mpRequest(`/preapproval/${encodeURIComponent(u.mp_subscription_id)}`);
        const expectedReference = `vdp_user_${req.user.id}`;
        const correctPlan = sub.external_reference === expectedReference &&
          Number(sub.auto_recurring?.transaction_amount) === PRICE &&
          sub.auto_recurring?.currency_id === CURRENCY &&
          Number(sub.auto_recurring?.frequency) === 1 &&
          sub.auto_recurring?.frequency_type === "months";
        if (correctPlan) {
          status = String(sub.status || "pending").toLowerCase();
          expiresAt = sub.next_payment_date ? new Date(sub.next_payment_date) : null;
          await pool.query(`
            UPDATE users SET subscription_status=$1, subscription_expires_at=$2,
              payer_email=COALESCE($3,payer_email)
            WHERE id=$4 AND mp_subscription_id=$5
          `, [status, expiresAt, sub.payer_email || null, req.user.id, String(sub.id)]);
        }
      } catch (syncError) {
        // Si Mercado Pago no responde, mostrar el último estado confirmado localmente.
        console.error("No se pudo sincronizar Mercado Pago:", syncError.message);
      }
    }

    const now = new Date();
    const adminPremiumActive = u.admin_premium_until && new Date(u.admin_premium_until) > now;
    const conektaPremiumActive = u.conekta_premium_until && new Date(u.conekta_premium_until) > now;
    const mpPremiumActive = status === "authorized" && (!expiresAt || new Date(expiresAt) > now);
    const active = Boolean(adminPremiumActive || conektaPremiumActive || mpPremiumActive);
    const premiumSource = adminPremiumActive ? "admin" : mpPremiumActive ? "mercadopago" : conektaPremiumActive ? "conekta" : null;
    const premiumExpiresAt = adminPremiumActive ? u.admin_premium_until :
      mpPremiumActive ? expiresAt : conektaPremiumActive ? u.conekta_premium_until : expiresAt;
    return res.json({
      ok:true, freeDownloadsUsed:u.free_downloads_used,
      freeDownloadsRemaining:active ? null : Math.max(0,FREE_DOWNLOAD_LIMIT-u.free_downloads_used),
      subscriptionActive:active, subscriptionStatus:adminPremiumActive ? "admin" : conektaPremiumActive && !mpPremiumActive ? "conekta" : status,
      premiumSource, adminPremiumUntil:u.admin_premium_until,
      conektaPremiumUntil:u.conekta_premium_until,
      subscriptionExpiresAt:premiumExpiresAt, price:PRICE, currency:CURRENCY,
      conektaEnabled:Boolean(process.env.CONEKTA_PRIVATE_KEY && process.env.CONEKTA_PUBLIC_KEY && process.env.CONEKTA_WEBHOOK_PUBLIC_KEY)
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

    const account = await pool.query("SELECT username FROM users WHERE id=$1", [userId]);
    await logAdminEvent({
      type: "subscription_changed", category: "payments", userId,
      username: account.rows[0]?.username,
      details: `Estado de suscripción actualizado: ${status}.`
    });

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
    await logAdminEvent({
      type: "subscription_cancelled", category: "payments", userId: req.user.id,
      username: req.user.username, details: "El usuario canceló su suscripción de Mercado Pago."
    });
    return res.json({ok:true, status:sub.status});
  } catch (error) {
    console.error("Cancel subscription:", error.message);
    return res.status(502).json({ok:false,error:"No se pudo cancelar la suscripción."});
  }
});

export default router;
