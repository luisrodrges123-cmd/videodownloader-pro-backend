
import { Router } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import jwt from "jsonwebtoken";
import { validateVideoUrl } from "./platforms.js";
import { pool } from "./db.js";

const router = Router();
const API_BASE = "https://knightvision.ai/api/v1/partner";

function getApiKey() {
  return process.env.KNIGHTVISION_API_KEY;
}

// ========================================
// CONFIGURACIÓN DE LA APLICACIÓN
// ========================================

async function getAppSettings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(50) PRIMARY KEY,
      setting_value BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO app_settings (setting_key, setting_value)
    VALUES
      ('free_mode', TRUE),
      ('maintenance_mode', FALSE)
    ON CONFLICT (setting_key) DO NOTHING
  `);

  const result = await pool.query(`
    SELECT setting_key, setting_value
    FROM app_settings
    WHERE setting_key IN ('free_mode', 'maintenance_mode')
  `);

  const settings = Object.fromEntries(
    result.rows.map(row => [
      row.setting_key,
      row.setting_value
    ])
  );

  return {
    freeMode: settings.free_mode ?? true,
    maintenanceMode: settings.maintenance_mode ?? false
  };
}

// ========================================
// AUTENTICACIÓN
// ========================================

async function getAuthenticatedUser(req) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return { user: null };
  }

  const secret = process.env.AUTH_SECRET;

  if (!secret) {
    throw new Error("Falta configurar AUTH_SECRET.");
  }

  try {
    const decoded = jwt.verify(match[1], secret);

    if (!decoded.id) {
      return { error: "Sesión inválida o expirada." };
    }

    const result = await pool.query(
      `SELECT id, username, is_blocked
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [decoded.id]
    );

    if (
      !result.rows.length ||
      result.rows[0].is_blocked
    ) {
      return { error: "Cuenta no disponible." };
    }

    return {
      user: {
        id: result.rows[0].id,
        username: result.rows[0].username
      }
    };

  } catch (error) {
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError" ||
      error.name === "NotBeforeError"
    ) {
      return { error: "Sesión inválida o expirada." };
    }

    throw error;
  }
}

// ========================================
// COMPROBAR PERMISOS
// ========================================

async function checkDownloadAccess(req, res) {
  try {
    const settings = await getAppSettings();
    if (settings.maintenanceMode) {
      res.status(503).json({ ok:false, error:"Estamos en mantenimiento. Intenta más tarde.", maintenanceMode:true });
      return false;
    }
    const auth = await getAuthenticatedUser(req);
    if (auth.error) {
      res.status(401).json({ ok:false, error:auth.error });
      return false;
    }
    if (!auth.user) {
      res.status(401).json({ ok:false, error:"Debes iniciar sesión para descargar videos.", loginRequired:true });
      return false;
    }
    req.user = auth.user;
    return true;
  } catch (error) {
    console.error("Download access:", error.stack || error.message);
    res.status(503).json({ ok:false, error:"No se pudieron verificar los permisos de descarga." });
    return false;
  }
}

async function reserveDownload(userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT free_downloads_used, subscription_status, subscription_expires_at
      FROM users WHERE id=$1 AND is_blocked=FALSE FOR UPDATE
    `, [userId]);
    if (!result.rowCount) throw new Error("Cuenta no disponible.");
    const user = result.rows[0];
    const paid = user.subscription_status === "authorized" &&
      (!user.subscription_expires_at || new Date(user.subscription_expires_at) > new Date());
    if (!paid && user.free_downloads_used >= 5) {
      await client.query("ROLLBACK");
      return { allowed:false, remaining:0 };
    }
    if (!paid) {
      await client.query("UPDATE users SET free_downloads_used=free_downloads_used+1 WHERE id=$1", [userId]);
    }
    await client.query("COMMIT");
    return { allowed:true, paid, remaining:paid ? null : Math.max(0,4-user.free_downloads_used) };
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally {
    client.release();
  }
}

async function releaseReservation(userId, paid) {
  if (!paid) await pool.query(
    "UPDATE users SET free_downloads_used=GREATEST(0,free_downloads_used-1) WHERE id=$1", [userId]
  );
}

async function ownsDownload(userId, providerId) {
  const result = await pool.query(
    "SELECT 1 FROM download_ownership WHERE provider_download_id=$1 AND user_id=$2",
    [providerId,userId]
  );
  return result.rowCount > 0;
}

// ========================================
// API KNIGHTVISION
// ========================================

async function knightvision(path, options = {}) {
  const key = getApiKey();

  if (!key) {
    throw new Error(
      "Falta configurar KNIGHTVISION_API_KEY en Render."
    );
  }

  const response = await fetch(
    `${API_BASE}${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(options.body
          ? { "Content-Type": "application/json" }
          : {}),
        ...options.headers
      }
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));

    throw new Error(
      error.error ||
      error.message ||
      `Knightvision respondió ${response.status}`
    );
  }

  return response;
}

// ========================================
// SOLICITAR DESCARGA
// POST /api/download
// ========================================

router.post("/", async (req, res) => {
  try {
    const allowed = await checkDownloadAccess(req, res);

    if (!allowed) return;

    const result = validateVideoUrl(req.body?.url);

    if (!result.valid) {
      return res.status(400).json({
        ok: false,
        error: result.reason
      });
    }

    const reservation = await reserveDownload(req.user.id);
    if (!reservation.allowed) {
      return res.status(402).json({
        ok:false, code:"SUBSCRIPTION_REQUIRED",
        error:"Ya utilizaste tus 5 descargas gratis. Activa VDownloader Pro por $29 MXN al mes.",
        freeDownloadsRemaining:0
      });
    }

    let response;
    try {
      response = await knightvision(
      "/social-download",
      {
        method: "POST",
        body: JSON.stringify({
          url: req.body.url
        })
      }
      );
    } catch (providerError) {
      await releaseReservation(req.user.id, reservation.paid);
      throw providerError;
    }

    const data = await response.json();

    if (!data.download_id) {
      await releaseReservation(req.user.id, reservation.paid);
      return res.status(502).json({
        ok: false,
        error: "Knightvision no devolvió un ID de descarga."
      });
    }

    await pool.query(`
      INSERT INTO download_ownership(provider_download_id,user_id,is_paid)
      VALUES($1,$2,$3)
      ON CONFLICT(provider_download_id) DO NOTHING
    `, [String(data.download_id), req.user.id, reservation.paid]);

    return res.status(202).json({
      ok: true,
      freeDownloadsRemaining: reservation.remaining,
      downloadId: data.download_id,
      status: data.status,
      platform: data.platform,
      message: "Video enviado a procesamiento."
    });

  } catch (error) {
    console.error(
      "Start download:",
      error.stack || error.message
    );

    return res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

// ========================================
// CONSULTAR ESTADO
// GET /api/download/:id
// ========================================

router.get("/:id", async (req, res) => {
  try {
    const allowed = await checkDownloadAccess(req, res);

    if (!allowed) return;

    const id = req.params.id;

    if (!/^kv-[a-zA-Z0-9-]+$/.test(id)) {
      return res.status(400).json({
        ok: false,
        error: "ID de descarga inválido."
      });
    }

    if (!(await ownsDownload(req.user.id, id))) {
      return res.status(404).json({ ok:false, error:"Descarga no encontrada para esta cuenta." });
    }

    const response = await knightvision(
      `/social-download/${encodeURIComponent(id)}`
    );

    const data = await response.json();

    return res.json({
      ok: true,
      downloadId: data.download_id,
      status: data.status,
      platform: data.platform,
      error: data.error || null,
      files: (data.files || []).map(file => ({
        idx: file.idx,
        kind: file.kind,
        name: file.download_name,
        available: file.available,
        downloadUrl:
          `/api/download/${encodeURIComponent(id)}/file/${file.idx}?download=1`
      }))
    });

  } catch (error) {
    console.error(
      "Download status:",
      error.stack || error.message
    );

    return res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

// ========================================
// ENTREGAR ARCHIVO
// GET /api/download/:id/file/:idx
// ========================================

router.get("/:id/file/:idx", async (req, res) => {
  try {
    const allowed = await checkDownloadAccess(req, res);

    if (!allowed) return;

    const { id, idx } = req.params;

    if (
      !/^kv-[a-zA-Z0-9-]+$/.test(id) ||
      !/^\d+$/.test(idx)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Archivo inválido."
      });
    }

    if (!(await ownsDownload(req.user.id, id))) {
      return res.status(404).json({ ok:false, error:"Descarga no encontrada para esta cuenta." });
    }

    const response = await knightvision(
      `/social-download/${encodeURIComponent(id)}/file/${idx}?download=1`
    );

    if (!response.body) {
      return res.status(502).json({
        ok: false,
        error: "Knightvision devolvió un archivo vacío."
      });
    }

    const contentType =
      response.headers.get("content-type") ||
      "application/octet-stream";

    const disposition =
      response.headers.get("content-disposition") || "";

    let filename = "video.mp4";

    const utf8Match = disposition.match(
      /filename\*=UTF-8''([^;]+)/i
    );

    const normalMatch = disposition.match(
      /filename="?([^";]+)"?/i
    );

    if (utf8Match) {
      try {
        filename = decodeURIComponent(utf8Match[1]);
      } catch {
        filename = "video.mp4";
      }
    } else if (normalMatch) {
      filename = normalMatch[1];
    }

    filename = filename
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[\r\n]/g, "")
      .trim()
      .slice(0, 150);

    if (!filename) {
      filename = "video.mp4";
    }

    res.setHeader("Content-Type", contentType);

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    res.setHeader("Cache-Control", "no-store");

    res.setHeader(
      "X-Content-Type-Options",
      "nosniff"
    );

    const length = response.headers.get("content-length");

    if (length) {
      res.setHeader("Content-Length", length);
    }

    await pipeline(
      Readable.fromWeb(response.body),
      res
    );

    // Registrar descarga completada.
    try {
      const statusResponse = await knightvision(
        `/social-download/${encodeURIComponent(id)}`
      );

      const data = await statusResponse.json();

      const platform = String(
        data.platform || "unknown"
      ).toLowerCase();

      await pool.query(
        "INSERT INTO downloads (platform) VALUES ($1)",
        [platform]
      );

    } catch (dbError) {
      console.error(
        "No se pudo registrar la descarga:",
        dbError.message
      );
    }

  } catch (error) {
    console.error(
      "Error entregando archivo:",
      error.stack || error.message
    );

    if (!res.headersSent) {
      res.status(502).json({
        ok: false,
        error: error.message
      });
    } else {
      res.destroy(error);
    }
  }
});

export default router;
