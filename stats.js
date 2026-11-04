
import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";

const router = Router();

let tablesReady;

async function ensureTables() {
  if (!tablesReady) {
    tablesReady = pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key VARCHAR(50) PRIMARY KEY,
        setting_value BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      INSERT INTO app_settings (setting_key, setting_value)
      VALUES ('free_mode', TRUE), ('maintenance_mode', FALSE)
      ON CONFLICT (setting_key) DO NOTHING;
    `).catch(error => {
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
      SELECT
        id,
        username,
        is_blocked,
        created_at
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

export default router;
