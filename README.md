# VideoDownloader Pro — Backend para Render

Backend inicial Node.js + Express.

## Incluye
- `GET /api/health`: estado del servidor.
- `POST /api/analyze`: valida el enlace y detecta TikTok, Instagram o Facebook.
- `POST /api/download`: ruta preparada, aún sin proveedor de descarga.
- Helmet, CORS y límite de solicitudes.
- `render.yaml` para desplegar en Render.

**Importante:** esta base no descarga videos todavía. Para habilitarlo hay que integrar un proveedor/API autorizado. No evade cuentas privadas, autenticación ni restricciones técnicas.

## Ejecutar localmente
Necesitas Node.js 20 o superior.
```bash
npm install
cp .env.example .env
npm run dev
```
Prueba `http://localhost:3000/api/health`.

## Publicar en Render
1. Sube esta carpeta a un repositorio de GitHub.
2. En Render elige **New + → Blueprint**.
3. Conecta el repositorio que contiene `render.yaml`.
4. Confirma el servicio `videodownloader-pro-api`.
5. Al terminar, abre la URL asignada más `/api/health`.

Configuración manual si hace falta:
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/health`

## Conectar el HTML
En `videodownloader_pro.html`, cambia:
```js
const API_BASE = "";
```
por la URL real de Render, sin `/api` al final:
```js
const API_BASE = "https://TU-SERVICIO.onrender.com";
```
Configura `ALLOWED_ORIGINS` en Render con el dominio donde alojes el HTML. `*` sirve para pruebas, no es recomendable para producción.

El historial actual sigue guardándose en el navegador. No pongas claves secretas en el HTML; guárdalas como variables de entorno en Render.
