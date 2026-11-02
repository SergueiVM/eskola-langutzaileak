# Despliegue en Cloudflare Pages

La aplicación usa Cloudflare Pages para servir la interfaz y Pages Functions para la API; D1 conserva los datos entre dispositivos. El acceso se protege con una contraseña compartida.

## Preparar el proyecto

1. Crea una base D1 gratuita desde el panel de Cloudflare o con `npx wrangler d1 create eskola-laguntzaileak`.
2. Comprueba que su ID coincide con `database_id` en `wrangler.toml`.
3. Inicializa el esquema relacional actual:

   ```sh
   npx wrangler d1 execute eskola-laguntzaileak --remote --file=schema.sql
   ```

4. Crea un proyecto Pages conectado al repositorio. Usa `mkdir -p dist/icons && cp index.html manifest.webmanifest sw.js dist/ && cp icons/* dist/icons/` como comando de compilación y `dist` como directorio de salida.
5. Configura los secretos `APP_PASSWORD` y `SESSION_SECRET` en Pages → Settings → Variables and Secrets, tanto para producción como para cualquier entorno de preview que vayas a utilizar. Usa una contraseña larga y aleatoria. Genera el secreto de sesión con `openssl rand -hex 32`.
6. En Pages → Settings → Functions, configura el binding D1 con nombre `DB` y selecciona la base creada. El nombre debe coincidir con `binding = "DB"` en `wrangler.toml`.
7. Despliega el proyecto y comprueba el acceso desde la URL HTTPS de Pages.

Los datos se guardan en tablas separadas (`people`, `jornadas`, `matches`, `availabilities` y `assignments`). Cada acción actualiza solo los registros implicados, en vez de reemplazar todo el estado; así, ediciones simultáneas en datos distintos no se pisan. La app carga el conjunto desde D1 al entrar. Si otra persona cambia datos mientras tienes la app abierta, pulsa **Actualizar** para ver sus cambios.

La app también se puede instalar como PWA desde el navegador. El service worker almacena en caché solo la interfaz, el manifiesto y el icono: no guarda respuestas de la API ni datos personales. Se necesita conexión para iniciar sesión, cargar y modificar los datos de D1.

La configuración local puede utilizar `.dev.vars` (archivo ignorado por Git):

```text
APP_PASSWORD=una-contraseña-larga
SESSION_SECRET=un-secreto-aleatorio-de-al-menos-32-bytes
```

Para desarrollo local, ejecuta `npx wrangler pages dev dist`; configura también el binding D1 local con Wrangler o usa una base remota de prueba. No compartas `.dev.vars` ni publiques secretos en el repositorio.

## Trasladar los datos existentes

Antes de publicar esta versión sobre la app antigua, abre la pestaña **Personas**, pulsa **Exportar** y guarda el contenido JSON. Tras desplegar y entrar en la nueva app, abre **Personas**, pega el JSON en **Copia de seguridad** y pulsa **Importar**. La importación sustituye todos los datos compartidos de D1. A partir de entonces, los datos se guardan en D1 y se comparten entre dispositivos. Conserva además una copia periódica usando **Exportar**.
.