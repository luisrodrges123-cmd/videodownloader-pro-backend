import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";

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

// Consultar usuarios
router.get("/admin/users", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, is_blocked, created_at
      FROM users
      ORDER BY created_at DESC
      LIMIT 500
    `);

    res.json({
      ok: true,
      users: result.rows
    });
  } catch (error) {
    console.error("Admin users:", error.message);
    res.status(503).json({
      error: "No se pudieron consultar los usuarios."
    });
  }
});

// ADMIN: consultar suscripciones y usuarios con su estado de pago
router.get("/admin/subscriptions", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, payer_email, mp_subscription_id,
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
      subscription_active: user.subscription_status === 'authorized' &&
        (!user.subscription_expires_at || new Date(user.subscription_expires_at) > new Date())
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
