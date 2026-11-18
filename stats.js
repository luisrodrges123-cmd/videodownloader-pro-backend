import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "./db.js";
import { eventTitle, logAdminEvent, sendWhatsAppTemplate, whatsappConfiguration } from "./events.js";

const router = Router();

let tablesReady;

async function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          setting_key VARCHAR(50) PRIMARY KEY,
          setting_value BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        INSERT INTO app_settings (setting_key, setting_value)
        VALUES ('free_mode', TRUE), ('maintenance_mode', FALSE)
        ON CONFLICT (setting_key) DO NOTHING;

        CREATE TABLE IF NOT EXISTS app_messages (
          id SERIAL PRIMARY KEY,
          title VARCHAR(120) NOT NULL,
          message TEXT NOT NULL,
          type VARCHAR(20) NOT NULL DEFAULT 'normal',
          display VARCHAR(20) NOT NULL DEFAULT 'popup',
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    })().catch(error => {
      tablesReady = null;
      throw error;
    });
  }

  await tablesReady;
}

function isAdmin(req) {
  const password = process.env.ADMIN_PASSWORD;
  const supplied = req.get("x-admin-password") || "";

  if (!password || !supplied) return false;

  const a = Buffer.from(password);
  const b = Buffer.from(supplied);

  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({
      error: "Acceso no autorizado."
    });
  }

  next();
}

function validateMessage(data) {
  const { title, message, type, display, active } = data || {};

  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.trim().length > 120 ||
    typeof message !== "string" ||
    !message.trim() ||
    message.trim().length > 5000
  ) {
    return "Escribe un título y un mensaje válido.";
  }

  if (!["normal", "importante", "urgente"].includes(type)) {
    return "Tipo de mensaje inválido.";
  }

  if (!["popup", "bar"].includes(display)) {
    return "Forma de mostrar el mensaje inválida.";
  }

  if (active !== undefined && typeof active !== "boolean") {
    return "Estado del mensaje inválido.";
  }

  return null;
}

// Estadísticas públicas
router.get("/", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM downloads
    `);

    res.json({
      ok: true,
      totalDownloads: result.rows[0].total
    });
  } catch {
    res.status(503).json({
      error: "Estadísticas no disponibles."
    });
  }
});

// Mensajes activos para el sitio público
router.get("/messages", async (_req, res) => {
  try {
    await ensureTables();

    const result = await pool.query(`
      SELECT id, title, message, type, display, created_at
      FROM app_messages
      WHERE active = TRUE
      ORDER BY created_at DESC
    `);

    res.json({
      ok: true,
      messages: result.rows
    });
  } catch (error) {
    console.error("Public messages:", error.message);
    res.status(503).json({
      error: "No se pudieron cargar los mensajes."
    });
  }
});

// Resumen privado
router.get("/admin", requireAdmin, async (_req, res) => {
  try {
    const totals = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '24 hours'
        )::int AS "last24Hours"
      FROM downloads
    `);

    const platforms = await pool.query(`
      SELECT platform, COUNT(*)::int AS count
      FROM downloads
      GROUP BY platform
      ORDER BY count DESC
    `);

    const recent = await pool.query(`
      SELECT id, platform, created_at
      FROM downloads
      ORDER BY created_at DESC
      LIMIT 100
    `);

    const users = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM users
    `);

    res.json({
      ok: true,
      totalDownloads: totals.rows[0].total,
      last24Hours: totals.rows[0].last24Hours,
      platformCounts: platforms.rows,
      recent: recent.rows,
      totalUsers: users.rows[0].total
    });
  } catch (error) {
    console.error("Admin stats:", error.message);
    res.status(503).json({
      error: "No se pudieron cargar las estadísticas."
    });
  }
});

// Gráficas y registro de actividad del panel.
router.get("/admin/activity", requireAdmin, async (req, res) => {
  try {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const timezone = process.env.APP_TIMEZONE || "America/Chihuahua";
    const [series, events] = await Promise.all([
      pool.query(`
        SELECT to_char(d.day::date, 'YYYY-MM-DD') AS day,
          COUNT(e.id) FILTER (WHERE e.category='users')::int AS users,
          COUNT(e.id) FILTER (WHERE e.event_type='download_completed')::int AS downloads,
          COUNT(e.id) FILTER (WHERE e.category='premium')::int AS premium,
          COUNT(e.id) FILTER (WHERE e.category='payments')::int AS payments,
          COUNT(e.id) FILTER (WHERE e.category='security')::int AS security,
          COUNT(e.id)::int AS events
        FROM generate_series(
          (NOW() AT TIME ZONE $2)::date - ($1::int - 1),
          (NOW() AT TIME ZONE $2)::date,
          INTERVAL '1 day'
        ) AS d(day)
        LEFT JOIN admin_events e ON (e.created_at AT TIME ZONE $2)::date=d.day::date
        GROUP BY d.day ORDER BY d.day
      `, [days, timezone]),
      pool.query(`
        SELECT e.id, e.event_type, e.category, e.username, e.details, e.created_at,
               COALESCE(o.state, 'solo_registro') AS delivery_state,
               o.last_error
        FROM admin_events e
        LEFT JOIN admin_alert_outbox o ON o.event_id=e.id
        ORDER BY e.created_at DESC
        LIMIT 150
      `)
    ]);
    res.json({ ok: true, days, series: series.rows, events: events.rows });
  } catch (error) {
    console.error("Admin activity:", error.message);
    res.status(500).json({ error: "No se pudo consultar la actividad." });
  }
});

// Estado y preferencias del bot. Los secretos nunca salen del servidor.
router.get("/admin/bot", requireAdmin, async (_req, res) => {
  try {
    const [settings, counts] = await Promise.all([
      pool.query(`SELECT enabled, alert_users, alert_downloads, alert_premium, alert_payments, alert_security, updated_at FROM admin_bot_settings WHERE singleton=TRUE`),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE state='pending')::int AS pending,
          COUNT(*) FILTER (WHERE state='failed')::int AS failed,
          COUNT(*) FILTER (WHERE state='sent' AND sent_at >= NOW()-INTERVAL '24 hours')::int AS sent_24h,
          MAX(sent_at) AS last_sent_at
        FROM admin_alert_outbox
      `)
    ]);
    res.json({ ok: true, settings: settings.rows[0], queue: counts.rows[0], whatsapp: whatsappConfiguration() });
  } catch (error) {
    console.error("Admin bot status:", error.message);
    res.status(500).json({ error: "No se pudo consultar el bot." });
  }
});

router.put("/admin/bot", requireAdmin, async (req, res) => {
  try {
    const values = ["enabled", "alert_users", "alert_downloads", "alert_premium", "alert_payments", "alert_security"].map(key => req.body?.[key]);
    if (values.some(value => typeof value !== "boolean")) {
      return res.status(400).json({ error: "Selecciona un valor para cada opción del bot." });
    }
    if (values[0] && !whatsappConfiguration().ready) {
      return res.status(503).json({ error: `Configura primero en Render: ${whatsappConfiguration().missing.join(", ")}.` });
    }
    const result = await pool.query(`
      UPDATE admin_bot_settings
      SET enabled=$1, alert_users=$2, alert_downloads=$3, alert_premium=$4,
          alert_payments=$5, alert_security=$6, updated_at=NOW()
      WHERE singleton=TRUE
      RETURNING enabled, alert_users, alert_downloads, alert_premium, alert_payments, alert_security, updated_at
    `, values);
    await logAdminEvent({
      type: "bot_settings_changed", category: "security", username: "Administrador",
      details: `Bot ${values[0] ? "activado" : "pausado"}; se actualizaron sus categorías de alerta.`
    });
    res.json({ ok: true, settings: result.rows[0], whatsapp: whatsappConfiguration() });
  } catch (error) {
    console.error("Admin bot save:", error.message);
    res.status(500).json({ error: "No se pudieron guardar las opciones del bot." });
  }
});

router.post("/admin/bot/test", requireAdmin, async (_req, res) => {
  const config = whatsappConfiguration();
  if (!config.ready) {
    return res.status(503).json({ error: `Configura en Render: ${config.missing.join(", ")}.` });
  }
  const eventId = await logAdminEvent({
    type: "bot_test", category: "security", username: "Administrador",
    details: "Mensaje de prueba solicitado desde el panel.", notify: false
  });
  try {
    await sendWhatsAppTemplate({ title: eventTitle("bot_test"), username: "Administrador", details: "El bot de alertas de VideoDownloader Pro está conectado." });
    if (eventId) await pool.query(`
      INSERT INTO admin_alert_outbox (event_id,state,attempts,last_attempt_at,sent_at)
      VALUES ($1,'sent',1,NOW(),NOW()) ON CONFLICT (event_id) DO NOTHING
    `, [eventId]);
    res.json({ ok: true, eventId, message: "Mensaje de prueba enviado." });
  } catch (error) {
    if (eventId) await pool.query(`
      INSERT INTO admin_alert_outbox (event_id,state,attempts,last_attempt_at,last_error)
      VALUES ($1,'failed',1,NOW(),$2) ON CONFLICT (event_id) DO NOTHING
    `, [eventId, String(error.message).slice(0, 700)]).catch(() => {});
    console.error("WhatsApp test:", error.message);
    res.status(502).json({ error: `No se pudo enviar la prueba: ${error.message}` });
  }
});

router.post("/admin/bot/retry", requireAdmin, async (_req, res) => {
  try {
    if (!whatsappConfiguration().ready) {
      return res.status(503).json({ error: "Configura WhatsApp en Render antes de reintentar." });
    }
    const settings = await pool.query("SELECT enabled FROM admin_bot_settings WHERE singleton=TRUE");
    if (!settings.rows[0]?.enabled) return res.status(409).json({ error: "Activa el bot para reintentar alertas." });
    const result = await pool.query(`
      UPDATE admin_alert_outbox SET state='pending', attempts=0, next_attempt_at=NOW(), last_error=NULL, updated_at=NOW()
      WHERE state='failed' RETURNING id
    `);
    res.json({ ok: true, retried: result.rowCount });
  } catch (error) {
    console.error("WhatsApp retry:", error.message);
    res.status(500).json({ error: "No se pudieron reintentar las alertas." });
  }
});

// Consultar usuarios
router.get("/admin/users", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, is_blocked, created_at, admin_premium_until, conekta_premium_until,
             subscription_status, subscription_expires_at,
             (admin_premium_until > NOW()) AS admin_premium_active
      FROM users
      ORDER BY created_at DESC
      LIMIT 500
    `);

    const users = result.rows.map(user => {
      const paidActive = user.subscription_status === "authorized" &&
        (!user.subscription_expires_at || new Date(user.subscription_expires_at) > new Date());
      const adminActive = Boolean(user.admin_premium_active);
      const conektaActive = Boolean(user.conekta_premium_until && new Date(user.conekta_premium_until) > new Date());
      return {
        ...user,
        premium_active: adminActive || paidActive || conektaActive,
        premium_source: adminActive ? "admin" : paidActive ? "mercadopago" : conektaActive ? "conekta" : null
      };
    });

    res.json({
      ok: true,
      users
    });
  } catch (error) {
    console.error("Admin users:", error.message);
    res.status(503).json({
      error: "No se pudieron consultar los usuarios."
    });
  }
});

// Crear cuentas desde el panel de administración, opcionalmente con Premium.
router.post("/admin/users", requireAdmin, async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const premium = req.body?.premium === true;
    const months = Number(req.body?.months || 1);

    if (!/^[a-z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: "El usuario debe tener entre 3 y 30 caracteres: letras, números o _." });
    }
    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({ error: "La contraseña debe tener entre 8 y 72 caracteres." });
    }
    if (premium && ![1, 3, 6, 12].includes(months)) {
      return res.status(400).json({ error: "Elige una duración Premium válida." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(`
      INSERT INTO users (username, password_hash, admin_premium_until)
      VALUES ($1, $2, CASE WHEN $3 THEN NOW() + ($4::text || ' months')::interval ELSE NULL END)
      RETURNING id, username, created_at, admin_premium_until,
                (admin_premium_until > NOW()) AS admin_premium_active
    `, [username, passwordHash, premium, months]);

    await logAdminEvent({
      type: "admin_user_created", category: "users", userId: result.rows[0].id,
      username, details: premium ? `Cuenta creada con Premium por ${months} meses.` : "Cuenta creada desde administración."
    });
    if (premium) await logAdminEvent({
      type: "premium_activated", category: "premium", userId: result.rows[0].id,
      username, details: `Premium activado durante ${months} meses al crear la cuenta.`
    });

    return res.status(201).json({ ok: true, user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ese nombre de usuario ya existe." });
    }
    console.error("Admin create user:", error.message);
    return res.status(500).json({ error: "No se pudo crear la cuenta." });
  }
});

// Activar o quitar Premium manual a una cuenta existente.
router.patch("/admin/users/:id/premium", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const active = req.body?.active;
    const months = Number(req.body?.months || 1);

    if (!Number.isInteger(id) || id < 1 || typeof active !== "boolean") {
      return res.status(400).json({ error: "Datos de cuenta inválidos." });
    }
    if (active && ![1, 3, 6, 12].includes(months)) {
      return res.status(400).json({ error: "Elige una duración Premium válida." });
    }

    const result = await pool.query(`
      UPDATE users
      SET admin_premium_until = CASE
        WHEN $1 THEN NOW() + ($2::text || ' months')::interval
        ELSE NULL
      END
      WHERE id = $3
      RETURNING id, username, admin_premium_until,
                (admin_premium_until > NOW()) AS admin_premium_active
    `, [active, months, id]);

    if (!result.rows.length) return res.status(404).json({ error: "Usuario no encontrado." });
    await logAdminEvent({
      type: active ? "premium_activated" : "premium_revoked", category: "premium",
      userId: result.rows[0].id, username: result.rows[0].username,
      details: active ? `Premium activado durante ${months} meses.` : "Premium retirado por administración."
    });
    return res.json({ ok: true, user: result.rows[0] });
  } catch (error) {
    console.error("Admin premium:", error.message);
    return res.status(500).json({ error: "No se pudo actualizar Premium." });
  }
});

// ADMIN: consultar suscripciones y usuarios con su estado de pago
router.get("/admin/subscriptions", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, payer_email, mp_subscription_id, admin_premium_until, conekta_premium_until,
             subscription_status, subscription_expires_at,
             free_downloads_used, created_at
      FROM users
      ORDER BY
        CASE WHEN subscription_status = 'authorized' THEN 0
             WHEN subscription_status = 'pending' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT 1000
    `);
    const users = result.rows.map(user => ({
      ...user,
      subscription_active: (user.admin_premium_until && new Date(user.admin_premium_until) > new Date()) ||
        (user.conekta_premium_until && new Date(user.conekta_premium_until) > new Date()) ||
        (user.subscription_status === 'authorized' &&
        (!user.subscription_expires_at || new Date(user.subscription_expires_at) > new Date())),
      premium_source: user.admin_premium_until && new Date(user.admin_premium_until) > new Date()
        ? 'admin' : user.subscription_status === 'authorized' &&
          (!user.subscription_expires_at || new Date(user.subscription_expires_at) > new Date()) ? 'mercadopago' :
          user.conekta_premium_until && new Date(user.conekta_premium_until) > new Date() ? 'conekta' : null
    }));
    res.json({
      ok: true,
      total: users.length,
      active: users.filter(u => u.subscription_active).length,
      pending: users.filter(u => u.subscription_status === 'pending').length,
      inactive: users.filter(u => !u.subscription_active && !['pending'].includes(u.subscription_status)).length,
      subscriptions: users
    });
  } catch (error) {
    console.error("Admin subscriptions:", error.message);
    res.status(500).json({ error: "No se pudieron consultar las suscripciones." });
  }
});

// Bloquear o desbloquear usuario
router.patch("/admin/users/:id/block", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const blocked = req.body?.blocked;

    if (!Number.isInteger(id) || id < 1 || typeof blocked !== "boolean") {
      return res.status(400).json({
        error: "Datos de usuario inválidos."
      });
    }

    const result = await pool.query(`
      UPDATE users
      SET is_blocked = $1
      WHERE id = $2
      RETURNING id, username, is_blocked
    `, [blocked, id]);

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Usuario no encontrado."
      });
    }

    await logAdminEvent({
      type: blocked ? "user_blocked" : "user_unblocked", category: "security",
      userId: result.rows[0].id, username: result.rows[0].username,
      details: blocked ? "Cuenta bloqueada desde administración." : "Cuenta desbloqueada desde administración."
    });

    res.json({
      ok: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error("Admin block:", error.message);
    res.status(500).json({
      error: "No se pudo actualizar el usuario."
    });
  }
});

// Consultar configuración
router.get("/admin/settings", requireAdmin, async (_req, res) => {
  try {
    await ensureTables();

    const result = await pool.query(`
      SELECT setting_key, setting_value
      FROM app_settings
    `);

    const settings = Object.fromEntries(
      result.rows.map(row => [row.setting_key, row.setting_value])
    );

    res.json({
      ok: true,
      settings: {
        freeMode: settings.free_mode ?? true,
        maintenanceMode: settings.maintenance_mode ?? false
      }
    });
  } catch (error) {
    console.error("Admin settings:", error.message);
    res.status(500).json({
      error: "No se pudo consultar la configuración."
    });
  }
});

// Guardar configuración
router.put("/admin/settings", requireAdmin, async (req, res) => {
  try {
    await ensureTables();

    const { freeMode, maintenanceMode } = req.body || {};

    if (
      typeof freeMode !== "boolean" ||
      typeof maintenanceMode !== "boolean"
    ) {
      return res.status(400).json({
        error: "Configuración inválida."
      });
    }

    await pool.query(`
      INSERT INTO app_settings (setting_key, setting_value)
      VALUES
        ('free_mode', $1),
        ('maintenance_mode', $2)
      ON CONFLICT (setting_key)
      DO UPDATE SET
        setting_value = EXCLUDED.setting_value,
        updated_at = NOW()
    `, [freeMode, maintenanceMode]);

    await logAdminEvent({
      type: "system_settings_changed", category: "security", username: "Administrador",
      details: `Modo gratuito: ${freeMode ? "activo" : "inactivo"}; mantenimiento: ${maintenanceMode ? "activo" : "inactivo"}.`
    });

    res.json({
      ok: true,
      settings: { freeMode, maintenanceMode }
    });
  } catch (error) {
    console.error("Admin settings save:", error.message);
    res.status(500).json({
      error: "No se pudo guardar la configuración."
    });
  }
});

// ADMIN: consultar todos los mensajes
router.get("/admin/messages", requireAdmin, async (_req, res) => {
  try {
    await ensureTables();

    const result = await pool.query(`
      SELECT *
      FROM app_messages
      ORDER BY created_at DESC
    `);

    res.json({
      ok: true,
      messages: result.rows
    });
  } catch (error) {
    console.error("Admin messages:", error.message);
    res.status(500).json({
      error: "No se pudieron consultar los mensajes."
    });
  }
});

// ADMIN: publicar mensaje
router.post("/admin/messages", requireAdmin, async (req, res) => {
  try {
    await ensureTables();

    const data = {
      ...req.body,
      type: req.body?.type ?? "normal",
      display: req.body?.display ?? "popup",
      active: req.body?.active ?? true
    };

    const validationError = validateMessage(data);

    if (validationError) {
      return res.status(400).json({
        error: validationError
      });
    }

    const result = await pool.query(`
      INSERT INTO app_messages
        (title, message, type, display, active)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [
      data.title.trim(),
      data.message.trim(),
      data.type,
      data.display,
      data.active
    ]);

    await logAdminEvent({
      type: "admin_notice_published", category: "security", username: "Administrador",
      details: `Aviso publicado: ${result.rows[0].title}.`
    });

    res.status(201).json({
      ok: true,
      message: result.rows[0]
    });
  } catch (error) {
    console.error("Create message:", error.message);
    res.status(500).json({
      error: "No se pudo publicar el mensaje."
    });
  }
});

// ADMIN: editar o activar/desactivar mensaje
router.patch("/admin/messages/:id", requireAdmin, async (req, res) => {
  try {
    await ensureTables();

    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        error: "ID inválido."
      });
    }

    const current = await pool.query(
      "SELECT * FROM app_messages WHERE id = $1",
      [id]
    );

    if (!current.rows.length) {
      return res.status(404).json({
        error: "Mensaje no encontrado."
      });
    }

    const old = current.rows[0];
    const data = {
      title: req.body?.title ?? old.title,
      message: req.body?.message ?? old.message,
      type: req.body?.type ?? old.type,
      display: req.body?.display ?? old.display,
      active: req.body?.active ?? old.active
    };

    const validationError = validateMessage(data);

    if (validationError) {
      return res.status(400).json({
        error: validationError
      });
    }

    const result = await pool.query(`
      UPDATE app_messages
      SET
        title = $1,
        message = $2,
        type = $3,
        display = $4,
        active = $5,
        updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `, [
      data.title.trim(),
      data.message.trim(),
      data.type,
      data.display,
      data.active,
      id
    ]);

    await logAdminEvent({
      type: "admin_notice_updated", category: "security", username: "Administrador",
      details: `Aviso actualizado: ${result.rows[0].title}.`
    });

    res.json({
      ok: true,
      message: result.rows[0]
    });
  } catch (error) {
    console.error("Update message:", error.message);
    res.status(500).json({
      error: "No se pudo actualizar el mensaje."
    });
  }
});

// ADMIN: eliminar mensaje
router.delete("/admin/messages/:id", requireAdmin, async (req, res) => {
  try {
    await ensureTables();

    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        error: "ID inválido."
      });
    }

    const result = await pool.query(
      "DELETE FROM app_messages WHERE id = $1 RETURNING id",
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Mensaje no encontrado."
      });
    }

    await logAdminEvent({
      type: "admin_notice_deleted", category: "security", username: "Administrador",
      details: `Aviso eliminado. ID: ${result.rows[0].id}.`
    });

    res.json({
      ok: true,
      message: "Mensaje eliminado."
    });
  } catch (error) {
    console.error("Delete message:", error.message);
    res.status(500).json({
      error: "No se pudo eliminar el mensaje."
    });
  }
});

export default router;
