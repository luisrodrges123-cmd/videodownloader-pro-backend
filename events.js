import { pool } from "./db.js";

const ALERT_COLUMN = {
  users: "alert_users",
  downloads: "alert_downloads",
  premium: "alert_premium",
  payments: "alert_payments",
  security: "alert_security"
};

const EVENT_TITLES = {
  user_registered: "Nuevo usuario registrado",
  admin_user_created: "Cuenta creada desde administración",
  login_succeeded: "Inicio de sesión",
  login_failed: "Intento de inicio de sesión fallido",
  profile_updated: "Perfil actualizado",
  download_requested: "Descarga solicitada",
  download_completed: "Descarga completada",
  download_failed: "Error al procesar una descarga",
  premium_activated: "Premium activado por administración",
  premium_revoked: "Premium retirado por administración",
  user_blocked: "Usuario bloqueado",
  user_unblocked: "Usuario desbloqueado",
  system_settings_changed: "Configuración general actualizada",
  bot_settings_changed: "Opciones del bot actualizadas",
  admin_notice_published: "Aviso publicado",
  admin_notice_updated: "Aviso actualizado",
  admin_notice_deleted: "Aviso eliminado",
  subscription_started: "Suscripción iniciada",
  subscription_changed: "Estado de suscripción actualizado",
  subscription_cancelled: "Suscripción cancelada",
  payment_error: "Error de suscripción o pago",
  bot_test: "Prueba del bot de WhatsApp"
};

export function eventTitle(type) {
  return EVENT_TITLES[type] || String(type || "Actividad").replaceAll("_", " ");
}

export function whatsappConfiguration() {
  const recipient = String(process.env.WHATSAPP_TO || "").trim();
  const accessToken = String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const templateName = String(process.env.WHATSAPP_TEMPLATE_NAME || "").trim();
  const recipientValid = /^\+?[1-9]\d{7,14}$/.test(recipient);
  const phoneNumberIdValid = /^\d+$/.test(phoneNumberId);
  const templateNameValid = /^[a-z0-9_]{1,512}$/.test(templateName);
  const ready = Boolean(accessToken && phoneNumberIdValid && templateNameValid && recipientValid);
  return {
    ready,
    recipient: ready ? `••••${recipient.replace(/\D/g, "").slice(-4)}` : "",
    missing: [
      !accessToken && "WHATSAPP_ACCESS_TOKEN",
      !phoneNumberIdValid && "WHATSAPP_PHONE_NUMBER_ID",
      !recipientValid && "WHATSAPP_TO (formato internacional)",
      !templateNameValid && "WHATSAPP_TEMPLATE_NAME (nombre válido)"
    ].filter(Boolean)
  };
}

export async function logAdminEvent({ type, category, userId = null, username = null, details = "", notify = true }) {
  try {
    const cleanCategory = ALERT_COLUMN[category] ? category : "security";
    const result = await pool.query(`
      INSERT INTO admin_events (event_type, category, user_id, username, details)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING id
    `, [String(type || "activity").slice(0, 50), cleanCategory, userId, username ? String(username).slice(0, 80) : null, String(details || "").replace(/[\r\n\t]+/g, " ").slice(0, 700)]);

    if (!notify || !whatsappConfiguration().ready) return result.rows[0]?.id;
    const settingColumn = ALERT_COLUMN[cleanCategory];
    const settings = await pool.query(`SELECT enabled, ${settingColumn} AS category_enabled FROM admin_bot_settings WHERE singleton=TRUE`);
    if (!settings.rows[0]?.enabled || !settings.rows[0]?.category_enabled) return result.rows[0]?.id;

    await pool.query(`
      INSERT INTO admin_alert_outbox (event_id)
      VALUES ($1)
      ON CONFLICT (event_id) DO NOTHING
    `, [result.rows[0].id]);
    return result.rows[0]?.id;
  } catch (error) {
    console.error("Admin event:", error.message);
    return null;
  }
}

export async function sendWhatsAppTemplate({ title, username = "—", details = "", createdAt = new Date() }) {
  const config = whatsappConfiguration();
  if (!config.ready) throw new Error(`Falta configurar: ${config.missing.join(", ")}`);

  const graphVersion = String(process.env.WHATSAPP_GRAPH_API_VERSION || "v27.0");
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error("WHATSAPP_GRAPH_API_VERSION no es válido.");
  const language = String(process.env.WHATSAPP_TEMPLATE_LANGUAGE || "es_MX");
  const recipient = String(process.env.WHATSAPP_TO).trim().replace(/^\+/, "");
  const date = new Date(createdAt).toLocaleString("es-MX", {
    timeZone: process.env.APP_TIMEZONE || "America/Chihuahua"
  });
  const values = [title, username || "—", details || "Sin detalles", date]
    .map(value => String(value).replace(/\s+/g, " ").trim().slice(0, 900));

  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID)}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: {
        name: process.env.WHATSAPP_TEMPLATE_NAME,
        language: { code: language },
        components: [{
          type: "body",
          parameters: values.map(text => ({ type: "text", text }))
        }]
      }
    }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `WhatsApp respondió ${response.status}`);
  return data.messages?.[0]?.id || null;
}

export async function sendWhatsAppPurchaseThankYou({ phone, username = "Cliente", premiumUntil }) {
  const accessToken = String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const templateName = String(process.env.WHATSAPP_PURCHASE_TEMPLATE_NAME || "purchase_thank_you").trim();
  const language = String(process.env.WHATSAPP_PURCHASE_TEMPLATE_LANGUAGE || "es_MX").trim();
  const recipient = String(phone || "").replace(/\D/g, "");
  const graphVersion = String(process.env.WHATSAPP_GRAPH_API_VERSION || "v27.0");
  if (!accessToken || !/^\d+$/.test(phoneNumberId) || !/^[a-z0-9_]{1,512}$/.test(templateName)) {
    throw new Error("Configura WhatsApp y la plantilla de agradecimiento en Render.");
  }
  if (!/^[1-9]\d{7,14}$/.test(recipient)) throw new Error("El usuario no tiene un número de WhatsApp válido.");
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error("WHATSAPP_GRAPH_API_VERSION no es válida.");

  const expiry = premiumUntil ? new Date(premiumUntil).toLocaleDateString("es-MX", {
    timeZone: process.env.APP_TIMEZONE || "America/Chihuahua"
  }) : "30 días";
  const values = [username || "Cliente", expiry]
    .map(value => String(value).replace(/\s+/g, " ").trim().slice(0, 900));
  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: {
        name: templateName,
        language: { code: language },
        components: [{
          type: "body",
          parameters: values.map(text => ({ type: "text", text }))
        }]
      }
    }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `WhatsApp respondió ${response.status}`);
  return data.messages?.[0]?.id || null;
}

let workerRunning = false;

async function sendNextAlert() {
  if (workerRunning || !whatsappConfiguration().ready) return;
  workerRunning = true;
  let item;
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT o.id, o.event_id, o.attempts, e.event_type, e.category, e.username, e.details, e.created_at,
             s.enabled, s.alert_users, s.alert_downloads, s.alert_premium, s.alert_payments, s.alert_security
      FROM admin_alert_outbox o
      JOIN admin_events e ON e.id=o.event_id
      CROSS JOIN admin_bot_settings s
      WHERE o.state='pending' AND o.next_attempt_at <= NOW() AND s.singleton=TRUE
      ORDER BY o.created_at
      LIMIT 1
      FOR UPDATE OF o SKIP LOCKED
    `);
    item = result.rows[0];
    if (!item) {
      await client.query("COMMIT");
      workerRunning = false;
      return;
    }

    const settingColumn = ALERT_COLUMN[item.category];
    if (!item.enabled || !item[settingColumn]) {
      await client.query("UPDATE admin_alert_outbox SET state='cancelled', updated_at=NOW() WHERE id=$1", [item.id]);
      await client.query("COMMIT");
      workerRunning = false;
      return;
    }

    await client.query(`
      UPDATE admin_alert_outbox
      SET state='sending', attempts=attempts+1, last_attempt_at=NOW(), updated_at=NOW()
      WHERE id=$1
    `, [item.id]);
    await client.query("COMMIT");
    item.attempts += 1;
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Admin alert queue:", error.message);
    workerRunning = false;
    return;
  } finally {
    client?.release();
  }

  if (!item) {
    workerRunning = false;
    return;
  }

  try {
    await sendWhatsAppTemplate({
      title: eventTitle(item.event_type),
      username: item.username,
      details: item.details,
      createdAt: item.created_at
    });
    await pool.query(`UPDATE admin_alert_outbox SET state='sent', sent_at=NOW(), last_error=NULL, updated_at=NOW() WHERE id=$1`, [item.id]);
  } catch (error) {
    const retryDelays = [15, 60, 300, 1800, 7200];
    const terminal = item.attempts >= 5;
    const delay = retryDelays[Math.min(item.attempts - 1, retryDelays.length - 1)];
    await pool.query(`
      UPDATE admin_alert_outbox
      SET state=$2, next_attempt_at=NOW()+($3::text || ' seconds')::interval,
          last_error=$4, updated_at=NOW()
      WHERE id=$1
    `, [item.id, terminal ? "failed" : "pending", delay, error.message.slice(0, 700)]).catch(dbError => console.error("Admin alert retry:", dbError.message));
  } finally {
    workerRunning = false;
  }
}

export function startAdminAlertWorker() {
  pool.query(`UPDATE admin_alert_outbox SET state='pending', updated_at=NOW() WHERE state='sending' AND updated_at < NOW()-INTERVAL '5 minutes'`)
    .catch(error => console.error("Admin alert recovery:", error.message));
  const timer = setInterval(() => { void sendNextAlert(); }, 5000);
  timer.unref?.();
}
