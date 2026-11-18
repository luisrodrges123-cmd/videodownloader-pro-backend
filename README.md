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

## Alertas, gráficas y bot de WhatsApp

El panel `admin-pro.html` incluye la sección **Alertas y bot**. Registra altas, inicios de sesión, descargas solicitadas/completadas, cambios Premium, suscripciones y bloqueos; muestra tendencias de 7, 30 o 90 días y mantiene una cola de alertas con reintentos.

Para habilitar WhatsApp Cloud API, crea una plantilla de utilidad aprobada en WhatsApp Manager. Usa el nombre `admin_activity_alert`, idioma `es_MX` y un cuerpo con cuatro variables:

```text
Alerta de VideoDownloader Pro: {{1}}
Usuario: {{2}}
Detalle: {{3}}
Fecha: {{4}}
```

En Render, agrega como variables privadas `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TO` (teléfono destinatario con código de país), `WHATSAPP_TEMPLATE_NAME=admin_activity_alert` y `WHATSAPP_TEMPLATE_LANGUAGE=es_MX`. `WHATSAPP_GRAPH_API_VERSION` y `APP_TIMEZONE` son opcionales. No coloques el token en el HTML ni en GitHub.

Después del despliegue, abre **Alertas y bot**, elige los tipos de actividad, activa el bot y usa **Enviar prueba**. Si una alerta falla, aparece en el registro; el bot reintenta automáticamente y el botón **Reintentar fallidas** vuelve a poner en cola las que agotaron reintentos. Las claves de Cloud API y el destinatario se leen solo desde el servidor. WhatsApp Cloud API envía plantillas con un nombre, idioma y parámetros desde el endpoint de mensajes de Meta ([referencia oficial](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview)).

El historial actual sigue guardándose en el navegador. No pongas claves secretas en el HTML; guárdalas como variables de entorno en Render.


## Conekta: Checkout integrado

La página ofrece Conekta como pago único de $29 MXN por 30 días de Premium; no se renueva automáticamente. Mercado Pago conserva su suscripción mensual automática. La llave privada de Conekta se usa solo en el servidor; el Checkout integrado envía los datos de pago directamente a Conekta. La cuenta se activa únicamente después de confirmar la orden con la API y/o recibir un webhook order.paid verificado.

En Render agrega CONEKTA_PRIVATE_KEY (llave privada como secreto), CONEKTA_PUBLIC_KEY (llave pública) y CONEKTA_WEBHOOK_PUBLIC_KEY (PEM público de verificación de webhooks). Registra en Conekta el endpoint https://videodownloader-pro-api.onrender.com/api/payments/conekta/webhook para el evento order.paid. El Checkout usa checkout.id y se monta dentro de la página.
