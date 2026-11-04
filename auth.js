
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "./db.js";

const router = express.Router();

const getSecret = () => {
  if (!process.env.AUTH_SECRET) {
    throw new Error("Falta configurar AUTH_SECRET");
  }
  return process.env.AUTH_SECRET;
};

// Crear tabla de usuarios
export async function initAuthDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(30) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_blocked BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Revisar el token del usuario
export async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : null;

    if (!token) {
      req.user = null;
      return next();
    }

    const decoded = jwt.verify(token, getSecret());

    const result = await pool.query(
      "SELECT id, username, is_blocked FROM users WHERE id = $1",
      [decoded.id]
    );

    if (!result.rows.length || result.rows[0].is_blocked) {
      return res.status(401).json({
        error: "Cuenta no disponible"
      });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    return res.status(401).json({
      error: "Sesión inválida o expirada"
    });
  }
}

// Exigir que el usuario tenga sesión
export function requiredAuth(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.user) {
      return res.status(401).json({
        error: "Debes iniciar sesión"
      });
    }
    next();
  });
}

// Registro
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
       RETURNING id, username`,
      [username, passwordHash]
    );

    const user = result.rows[0];

    const token = jwt.sign(
      { id: user.id },
      getSecret(),
      { expiresIn: "7d" }
    );

    res.status(201).json({
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
    res.status(500).json({
      error: "No se pudo crear la cuenta"
    });
  }
});

// Inicio de sesión
router.post("/login", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT id, username, password_hash, is_blocked
       FROM users WHERE username = $1`,
      [username]
    );

    if (!result.rows.length) {
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
      return res.status(401).json({
        error: "Usuario o contraseña incorrectos, o cuenta bloqueada"
      });
    }

    const token = jwt.sign(
      { id: user.id },
      getSecret(),
      { expiresIn: "7d" }
    );

    res.json({
      message: "Sesión iniciada",
      token,
      user: {
        id: user.id,
        username: user.username
      }
    });
  } catch (error) {
    console.error("Error en login:", error);
    res.status(500).json({
      error: "No se pudo iniciar sesión"
    });
  }
});

// Consultar sesión actual
router.get("/me", requiredAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
