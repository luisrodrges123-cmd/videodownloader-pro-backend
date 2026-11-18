
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "./db.js";
import { logAdminEvent } from "./events.js";

const router = express.Router();

function getSecret() {
  if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
    throw new Error("AUTH_SECRET debe tener al menos 32 caracteres");
  }

  return process.env.AUTH_SECRET;
}

// Crear tabla de usuarios
export async function initAuthDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(30) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS free_downloads_used INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS payer_email TEXT,
      ADD COLUMN IF NOT EXISTS mp_subscription_id TEXT,
      ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS admin_premium_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS display_name VARCHAR(50),
      ADD COLUMN IF NOT EXISTS email VARCHAR(254),
      ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
      ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS conekta_premium_until TIMESTAMPTZ
  `);
}

// Comprobar sesión opcional
export async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      req.user = null;
      return next();
    }

    const token = header.slice(7);
    const decoded = jwt.verify(token, getSecret());

    const result = await pool.query(
      `SELECT id, username, display_name, email, phone, whatsapp_opt_in, created_at, is_blocked
       FROM users
       WHERE id = $1`,
      [decoded.id]
    );

    if (!result.rows.length || result.rows[0].is_blocked) {
      return res.status(401).json({
        error: "Cuenta no disponible"
      });
    }

    req.user = {
      id: result.rows[0].id,
      username: result.rows[0].username,
      display_name: result.rows[0].display_name,
      email: result.rows[0].email,
      phone: result.rows[0].phone,
      whatsapp_opt_in: result.rows[0].whatsapp_opt_in,
      created_at: result.rows[0].created_at
    };

    return next();
  } catch (error) {
    return res.status(401).json({
      error: "Sesión inválida o expirada"
    });
  }
}

// Exigir inicio de sesión
export async function requiredAuth(req, res, next) {
  try {
    await optionalAuth(req, res, () => {
      if (!req.user && !res.headersSent) {
        res.status(401).json({
          error: "Debes iniciar sesión"
        });
      }
    });

    if (res.headersSent) return;

    if (!req.user) {
      return res.status(401).json({
        error: "Debes iniciar sesión"
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

// Registrar usuario
router.post("/register", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!/^[a-z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({
        error: "El usuario debe tener entre 3 y 30 caracteres: letras, números o _"
      });
    }

    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({
        error: "La contraseña debe tener entre 8 y 72 caracteres"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username, display_name, email, phone, whatsapp_opt_in, created_at`,
      [username, passwordHash]
    );

    const user = result.rows[0];
    await logAdminEvent({
      type: "user_registered", category: "users", userId: user.id,
      username: user.username, details: "Registro desde la página pública."
    });

    const token = jwt.sign(
      { id: user.id },
      getSecret(),
      { expiresIn: "7d" }
    );

    return res.status(201).json({
      message: "Cuenta creada correctamente",
      token,
      user
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "Ese nombre de usuario ya existe"
      });
    }

    console.error("Error en registro:", error);

    return res.status(500).json({
      error: "No se pudo crear la cuenta"
    });
  }
});

// Iniciar sesión
router.post("/login", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT id, username, display_name, email, phone, whatsapp_opt_in, created_at, password_hash, is_blocked
       FROM users
       WHERE username = $1`,
      [username]
    );

    if (!result.rows.length) {
      await logAdminEvent({
        type: "login_failed", category: "security", username,
        details: "Nombre de usuario no encontrado."
      });
      return res.status(401).json({
        error: "Usuario o contraseña incorrectos"
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid || user.is_blocked) {
      await logAdminEvent({
        type: "login_failed", category: "security", userId: user.id,
        username: user.username,
        details: user.is_blocked ? "Intento de acceso a cuenta bloqueada." : "Contraseña incorrecta."
      });
      return res.status(401).json({
        error: "Usuario o contraseña incorrectos, o cuenta bloqueada"
      });
    }

    const token = jwt.sign(
      { id: user.id },
      getSecret(),
      { expiresIn: "7d" }
    );

    await logAdminEvent({
      type: "login_succeeded", category: "security", userId: user.id,
      username: user.username, details: "Inicio de sesión correcto."
    });

    return res.json({
      message: "Sesión iniciada",
      token,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        email: user.email,
        phone: user.phone,
        whatsapp_opt_in: user.whatsapp_opt_in,
        created_at: user.created_at
      }
    });
  } catch (error) {
    console.error("Error en login:", error);

    return res.status(500).json({
      error: "No se pudo iniciar sesión"
    });
  }
});

// Consultar usuario conectado
router.get("/me", requiredAuth, (req, res) => {
  return res.json({
    user: req.user
  });
});

// Guardar el perfil asociado a la cuenta autenticada.
router.put("/profile", requiredAuth, async (req, res) => {
  try {
    const displayName = String(req.body?.display_name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const rawPhone = String(req.body?.phone || "").trim().replace(/[\s()-]/g, "");
    const phone = rawPhone ? rawPhone.replace(/\D/g, "") : "";
    const whatsappOptIn = req.body?.whatsapp_opt_in === true;

    if (displayName.length < 2 || displayName.length > 50) {
      return res.status(400).json({ error: "El nombre de perfil debe tener entre 2 y 50 caracteres." });
    }
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return res.status(400).json({ error: "Escribe un correo electrónico válido." });
    }
    if (rawPhone && !/^\+[1-9]\d{7,14}$/.test(rawPhone)) {
      return res.status(400).json({ error: "Escribe tu WhatsApp con código de país, por ejemplo +52 656 123 4567." });
    }
    if (whatsappOptIn && !phone) {
      return res.status(400).json({ error: "Agrega tu número de WhatsApp antes de autorizar mensajes." });
    }

    const result = await pool.query(`
      UPDATE users
      SET display_name=$1, email=$2, phone=$3, whatsapp_opt_in=$4
      WHERE id=$5
      RETURNING id, username, display_name, email, phone, whatsapp_opt_in, created_at
    `, [displayName, email || null, phone || null, whatsappOptIn, req.user.id]);

    if (!result.rows.length) return res.status(404).json({ error: "Cuenta no encontrada." });
    const whatsappAuthorizationChanged = whatsappOptIn &&
      (!req.user.whatsapp_opt_in || req.user.phone !== phone);
    await logAdminEvent({
      type: whatsappAuthorizationChanged ? "whatsapp_opt_in" : "profile_updated",
      category: "security", userId: req.user.id,
      username: req.user.username,
      details: whatsappAuthorizationChanged
        ? "El usuario autorizó las confirmaciones de compra por WhatsApp."
        : "El usuario actualizó su perfil."
    });
    return res.json({ ok: true, user: result.rows[0] });
  } catch (error) {
    console.error("Update profile:", error.message);
    return res.status(500).json({ error: "No se pudo guardar el perfil." });
  }
});

export default router;
