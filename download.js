
import { Router } from "express";
import { Readable } from "node:stream";
import { validateVideoUrl } from "./platforms.js";

const router = Router();

const API_BASE = "https://knightvision.ai/api/v1/partner";

function getApiKey() {
  return process.env.KNIGHTVISION_API_KEY;
}

async function knightvision(path, options = {}) {
  const key = getApiKey();

  if (!key) {
    throw new Error("Falta configurar KNIGHTVISION_API_KEY en Render.");
  }

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

// Solicitar una descarga
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

    return res.status(202).json({
      ok: true,
      downloadId: data.download_id,
      status: data.status,
      platform: data.platform,
      message: "Video enviado a procesamiento."
    });
  } catch (error) {
    return res.status(502).json({
      error: error.message || "No se pudo solicitar la descarga."
    });
  }
});

// Consultar el estado
router.get("/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!/^kv-[a-zA-Z0-9-]+$/.test(id)) {
      return res.status(400).json({ error: "ID de descarga inválido." });
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
        downloadUrl: `/api/download/${encodeURIComponent(id)}/file/${file.idx}`
      }))
    });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

// Entregar el archivo al visitante
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

    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") || "video/mp4"
    );

    const disposition = response.headers.get("content-disposition");
    if (disposition) {
      res.setHeader("Content-Disposition", disposition);
    }

    const length = response.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);

    if (!response.body) {
      return res.status(502).json({ error: "Archivo vacío." });
    }

    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({ error: error.message });
    } else {
      res.destroy(error);
    }
  }
});

export default router;
