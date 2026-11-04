
import { Router } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { validateVideoUrl } from "./platforms.js";
import { pool } from "./db.js";

const router = Router();
const API_BASE = "https://knightvision.ai/api/v1/partner";

function getApiKey() {
  return process.env.KNIGHTVISION_API_KEY;
}

async function knightvision(path, options = {}) {
  const key = getApiKey();

  if (!key) throw new Error("Falta configurar KNIGHTVISION_API_KEY.");

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Knightvision respondió ${response.status}`);
  }

  return response;
}

// Solicitar descarga
router.post("/", async (req, res) => {
  try {
    const result = validateVideoUrl(req.body?.url);

    if (!result.valid) {
      return res.status(400).json({ error: result.reason });
    }

    const response = await knightvision("/social-download", {
      method: "POST",
      body: JSON.stringify({ url: req.body.url })
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
    res.status(502).json({ error: error.message });
  }
});

// Consultar estado
router.get("/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!/^kv-[a-zA-Z0-9-]+$/.test(id)) {
      return res.status(400).json({ error: "ID inválido." });
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
        downloadUrl: `/api/download/${encodeURIComponent(id)}/file/${file.idx}`
      }))
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// Entregar archivo y registrar descarga terminada
router.get("/:id/file/:idx", async (req, res) => {
  try {
    const { id, idx } = req.params;

    if (!/^kv-[a-zA-Z0-9-]+$/.test(id) || !/^\d+$/.test(idx)) {
      return res.status(400).json({ error: "Archivo inválido." });
    }

    const suffix = req.query.download === "1" ? "?download=1" : "";

    const response = await knightvision(
      `/social-download/${encodeURIComponent(id)}/file/${idx}${suffix}`
    );

    if (!response.body) {
      return res.status(502).json({ error: "Archivo vacío." });
    }

    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") || "video/mp4"
    );

    const disposition = response.headers.get("content-disposition");
    if (disposition) res.setHeader("Content-Disposition", disposition);

    const length = response.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);

    await pipeline(Readable.fromWeb(response.body), res);

    // Solo se registra si el envío terminó correctamente.
    try {
      const statusResponse = await knightvision(
        `/social-download/${encodeURIComponent(id)}`
      );
      const data = await statusResponse.json();

      const platform = String(data.platform || "unknown").toLowerCase();

      await pool.query(
        "INSERT INTO downloads (platform) VALUES ($1)",
        [platform]
      );
    } catch (dbError) {
      console.error("No se pudo registrar la descarga:", dbError.message);
    }

  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({ error: error.message });
    } else {
      res.destroy(error);
    }
  }
});

export default router;
