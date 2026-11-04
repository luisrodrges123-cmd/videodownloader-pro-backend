
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

    if (!result.rows.length || result.rows[0].is_blocked) {
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
// CONFIGURACIÓN DE LA APLICACIÓN
// ========================================

async function getAppSettings() {
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
// COMPROBAR PERMISOS DE DESCARGA
// ========================================

async function checkDownloadAccess(req, res) {
  try {
    const settings = await getAppSettings();

    if (settings.maintenanceMode) {
      res.status(503).json({
        error: "Estamos en mantenimiento. Intenta más tarde.",
        maintenanceMode: true
      });

      return false;
    }

    const auth = await getAuthenticatedUser(req);

    if (auth.error) {
      res.status(401).json({
        error: auth.error
      });

      return false;
    }

    if (!settings.freeMode && !auth.user) {
      res.status(401).json({
        error: "Debes iniciar sesión para descargar videos.",
        loginRequired: true
      });

      return false;
    }

    req.user = auth.user;

    return true;
  } catch (error) {
    console.error("Download access:", error.message);

    res.status(503).json({
      error: "No se pudieron verificar los permisos de descarga."
    });

    return false;
  }
}

// ========================================
// API DE KNIGHTVISION
// ========================================

async function knightvision(path, options = {}) {
  const key = getApiKey();

  if (!key) {
    throw new Error("Falta configurar KNIGHTVISION_API_KEY.");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(options.body
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));

    throw new Error(
      error.error || `Knightvision respondió ${response.status}`
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
        error: result.reason
      });
    }

    const response = await knightvision("/social-download", {
      method: "POST",
      body: JSON.stringify({
        url: req.body.url
      })
    });

    const data = await response.json();

    res.status(202).json({
      ok: true,
      downloadId: data.download_id,
      status: data.status,
      platform: data.platform,
      message: "Video enviado a procesamiento."
    });

  } catch (error) {
    console.error("Start download:", error.message);

    res.status(502).json({
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
        error: "ID inválido."
      });
    }

    const response = await knightvision(
      `/social-download/${encodeURIComponent(id)}`
    );

    const data = await response.json();

    res.json({
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
    console.error("Download status:", error.message);

    res.status(502).json({
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
        error: "Archivo inválido."
      });
    }

    const response = await knightvision(
      `/social-download/${encodeURIComponent(id)}/file/${idx}?download=1`
    );

    if (!response.body) {
      return res.status(502).json({
        error: "Archivo vacío."
      });
    }

    const contentType =
      response.headers.get("content-type") || "video/mp4";

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
      error.message
    );

    if (!res.headersSent) {
      res.status(502).json({
        error: error.message
      });
    } else {
      res.destroy(error);
    }
  }
});

export default router;
