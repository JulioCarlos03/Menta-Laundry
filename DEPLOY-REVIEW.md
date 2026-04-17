# Menta Laundry Review Deploy

Objetivo: compartir una version revisable del proyecto con terceros usando:

- Frontend: `demo.mentalaundry.com`
- Backend/API: `api.mentalaundry.com`

## 1. Prepara el repo

- No subas `tintoreria-backend/.env` al repositorio.
- Usa `tintoreria-backend/.env.example` solo como plantilla.
- La SMTP key de Brevo ya se expuso en chat: regenerala cuando la revision quede funcionando.

## 2. Publica el backend en Render

- Crea un nuevo `Web Service` desde este repo.
- Si Render te deja elegir carpeta raiz, usa `tintoreria-backend`.
- Render ya puede leer `render.yaml`, pero igual revisa:
  - Build command: `npm install`
  - Start command: `npm start`
  - Health check: `/api/health`

Variables necesarias en Render:

- `PORT`: lo pone Render automaticamente
- `USE_LEGACY_DEMO_SERVER=false`
- `MONGODB_URI`
- `JWT_SECRET`
- `JWT_EXPIRES_IN=7d`
- `APP_BASE_URL=https://demo.mentalaundry.com/`
- `CORS_ALLOWED_ORIGINS=http://127.0.0.1:5500,http://localhost:5500,https://mentalaundry.com,https://www.mentalaundry.com,https://demo.mentalaundry.com`
- `CORS_ALLOWED_ORIGIN_SUFFIXES=.netlify.app,.onrender.com,.vercel.app`
- `EMAIL_FROM=Menta Laundry <admin@mentalaundry.com>`
- `EMAIL_REPLY_TO=admin@mentalaundry.com`
- `SMTP_HOST=smtp-relay.brevo.com`
- `SMTP_PORT=587`
- `SMTP_SECURE=false`
- `SMTP_USER`
- `SMTP_PASS`

Cuando Render termine, prueba:

- `https://TU-SERVICIO.onrender.com/api/health`

Debe devolver `emailMode`, `appBaseUrl` y `db`.

## 3. Publica el frontend en Netlify

- Importa este repo en Netlify.
- Netlify puede leer `netlify.toml`.
- Si te pide directorio base, usa `TINTORERIA-FRONTEND`.
- No necesitas build command para esta version estatica.

Antes de publicar, edita `TINTORERIA-FRONTEND/config.js`:

```js
window.__MENTA_CONFIG__ = {
  apiBase: "https://TU-SERVICIO.onrender.com/api",
};
```

Mas adelante, cuando `api.mentalaundry.com` este listo, cambia ese valor por:

```js
window.__MENTA_CONFIG__ = {
  apiBase: "https://api.mentalaundry.com/api",
};
```

## 4. Conecta los dominios

En Netlify:

- agrega `demo.mentalaundry.com`

En Render:

- agrega `api.mentalaundry.com`

Luego en Squarespace crea los DNS que te pidan Netlify y Render.

## 5. Ajustes finales

- En Render deja `APP_BASE_URL=https://demo.mentalaundry.com/`
- En `TINTORERIA-FRONTEND/config.js` deja `apiBase=https://api.mentalaundry.com/api`
- Prueba registro, login, verificacion por correo y recuperacion de contrasena

## 6. Enlace para aprobacion

Comparte:

- `https://demo.mentalaundry.com`

Y como enlace tecnico opcional:

- `https://api.mentalaundry.com/api/health`
