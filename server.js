
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import analyze from "./analyze.js";
import download from "./download.js";
import stats from "./stats.js";
import payments from "./payments.js";
import auth, { initAuthDb } from "./auth.js";
import { initDb } from "./db.js";
import { notFound, errorHandler } from "./errors.js";

const app = express();
const port = Number(process.env.PORT || 3000);

const origins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(x => x.trim());

app.disable("x-powered-by");
app.use(helmet());

app.use(cors({
  origin(origin, cb) {
    if (!origin || origins.includes("*") || origins.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error("Origen no permitido por CORS."));
  }
}));

app.use(express.json({ limit: "10kb" }));

app.use("/api", rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Intenta más tarde." }
}));

app.get("/", (_req, res) =>
  res.json({ name: "VideoDownloader Pro API", status: "online" })
);

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, service: "VideoDownloader Pro API" })
);

app.use("/api/auth", auth);
app.use("/api/analyze", analyze);
app.use("/api/download", download);
app.use("/api/stats", stats);
app.use("/api/payments", payments);

app.use(notFound);
app.use(errorHandler);

async function startServer() {
  try {
    // Primero crear/migrar users; después las tablas que dependen de users.
    await initAuthDb();
    await initDb();

    console.log("PostgreSQL conectado y tablas listas.");

    app.listen(port, "0.0.0.0", () => {
      console.log("API listening on " + port);
    });
  } catch (error) {
    console.error("Error iniciando el servidor:", error);
    process.exit(1);
  }
}

startServer();
