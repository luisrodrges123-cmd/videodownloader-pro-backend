
import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";

const router = Router();

function isAdmin(req) {
  const password = process.env.ADMIN_PASSWORD;
  const supplied = req.get("x-admin-password") || "";

  if (!password || !supplied) return false;

  const a = Buffer.from(password);
  const b = Buffer.from(supplied);

  return a.length === b.length && timingSafeEqual(a, b);
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
    res.status(503).json({ error: "Estadísticas no disponibles." });
  }
});

// Estadísticas privadas
router.get("/admin", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "Acceso no autorizado." });
  }

  try {
    const totals = await pool.query(`
      SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE created_at >= NOW() - INTERVAL '24 hours'
      )::int AS last24Hours
      FROM downloads
    `);

    const platforms = await pool.query(`
      SELECT platform, COUNT(*)::int AS total
      FROM downloads
      GROUP BY platform
      ORDER BY total DESC
    `);

    const recent = await pool.query(`
      SELECT platform, created_at
      FROM downloads
      ORDER BY created_at DESC
      LIMIT 20
    `);

    res.json({
      ok: true,
      totals: totals.rows[0],
      platforms: platforms.rows,
      recent: recent.rows
    });
  } catch {
    res.status(503).json({ error: "No se pudieron cargar las estadísticas." });
  }
});

export default router;
