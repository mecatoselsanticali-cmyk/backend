# Backend — Mecatos el Santi

Contexto específico del paquete `backend/` (API Express + workers de colas).
Lee primero el `CLAUDE.md` de la raíz del repo (modelo de auth, cookies,
zona horaria de Colombia, convenciones generales) — acá solo lo específico
de este paquete. Los números de punto son los mismos que en el archivo
raíz (no se renumeraron al dividir el documento) — si ves un comentario en
el código que diga "ver punto 19 de CLAUDE.md", el índice del archivo raíz
te dice en cuál de estos archivos vive cada número.

### 1. Todo controlador async DEBE envolverse en `asyncHandler`

`backend/src/utils/asyncHandler.ts` envuelve cada handler de ruta. **Nunca**
registres una ruta con un controlador async sin esto:

```ts
router.post("/sales", requirePosSession, asyncHandler(createSale)); // ✅
router.post("/sales", requirePosSession, createSale);                // ❌
```

Sin `asyncHandler`, si una promesa dentro del controlador rechaza (ej. Redis
tiene un hiccup al encolar un job), Express no captura el rechazo y la
petición se queda sin respuesta — el cliente (el POS) se cuelga en
"Procesando..." indefinidamente. Esto ya pasó una vez en este proyecto; no lo
repitas al agregar rutas nuevas.

### 2. La emisión DIAN es 100% asíncrona vía BullMQ — nunca la llames inline

`dianService.emit()` (mock hoy, PTA real después) **solo se llama desde
`workers/dianWorker.ts`**, nunca directamente desde un controlador HTTP. El
flujo correcto para cualquier venta nueva:

```
controlador → guarda Sale en Mongo (dianStatus: PENDING)
            → enqueueSaleForDianEmission(saleId)  [try/catch, nunca debe tumbar la respuesta]
            → responde al cliente inmediatamente
            ↓ (en otro proceso)
worker → toma el job → dianService.emit() → actualiza Sale.dianStatus
```

Si agregas un nuevo flujo que genera ventas (ej. webhook de Rappi/DiDi),
sigue este mismo patrón.

### 3. Job de reconciliación — no lo dupliques ni lo borres sin más

`backend/src/jobs/reconcilePendingDianSales.ts` corre dentro de
`dianWorker.ts` (setInterval, cada `RECONCILE_INTERVAL_MINUTES`) y también vía
`npm run reconcile:dian` (manual). Reencola ventas `dianStatus: PENDING` con
más de `RECONCILE_STALE_MINUTES` de antigüedad que no tengan ya un job vivo en
la cola (deduplicación por `jobId` determinístico: `dian-emission-<saleId>`,
ver `hasLiveDianJob()` en `queues/dianQueue.ts`).

**A propósito no reintenta ventas `REJECTED`** (fallaron los 5 reintentos del
worker) — esas requieren revisión manual en `/ventas` del admin, porque un
rechazo definitivo del PTA suele ser un problema de datos, no de
infraestructura. No cambies esto sin discutirlo explícitamente.

### 4. Redis: soporta `REDIS_URL` (managed) y host/puerto sueltos (local)

`backend/src/config/redis.ts` prioriza `REDIS_URL` si está definida (para
Upstash/Redis Cloud/ElastiCache en producción, con TLS vía `rediss://`) y cae
a `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` si no. No agregues una segunda
forma de configurar la conexión — extiende esta.

**Gotcha real que ya pasó (`redis://` vs `rediss://`):** una `REDIS_URL` de
Upstash con el esquema `redis://` (sin la `s` de TLS) en vez de `rediss://`
produce un síntoma muy engañoso: el socket TCP conecta bien (`[Redis]
Conectado correctamente` se loguea normal), pero cada comando real se
resetea (`[Redis] Error de conexión: read ECONNRESET`) en un loop de
reconexión infinito — porque el proxy de Upstash espera un handshake TLS
inmediatamente y en cambio recibe comandos RESP en texto plano. Como
`maxRetriesPerRequest: null` (arriba) hace que ioredis reintente para
siempre sin nunca rechazar la promesa, **no aparece ningún error en la
consola del backend** — los `Queue.add()` de BullMQ simplemente quedan
colgados para siempre, sin encolar nada y sin fallar visiblemente. La
señal más confiable para diagnosticar esto: el dashboard de uso del
proveedor (ej. "Usage" de Upstash) muestra **cero comandos ejecutados**,
aunque la app lleve rato "funcionando". Si ves este patrón exacto
(reconecta sin parar, cero comandos según el proveedor, nada se encola),
revisa el esquema de `REDIS_URL` antes que cualquier otra cosa.

### 5. El worker DIAN es un proceso separado del API — siempre

Nunca metas `dianWorker.ts` a correr dentro de `server.ts`/`app.ts`. En
despliegues (Railway, Render, Docker) son dos servicios distintos que
comparten Mongo y Redis. `docker-compose.yml` ya lo modela así (`backend` y
`dian-worker`).

### 7. jwt.sign y tipos de `expiresIn`

`@types/jsonwebtoken` reciente es estricto con el tipo de `expiresIn` (no
acepta `string` genérico). Si agregas una nueva firma de JWT, sigue el patrón
ya usado en `authController.ts`: tipar explícitamente como `SignOptions` y
castear `expiresIn as SignOptions["expiresIn"]`.

### 10. `dianService.ts` es el único punto de integración con el PTA

Cuando se conecten credenciales reales de Factus (o el proveedor que sea),
**todo el cambio va dentro de `DianService.emit()`** — el TODO ya está
marcado ahí. No toques el worker, la cola, ni los controladores: la interfaz
`DianEmissionResult` ya está diseñada para eso.

### 14. El SKU de producto se genera en el backend, nunca se recibe del cliente

`createProduct` (`backend/src/controllers/adminController.ts`) genera el
SKU automáticamente: 3 letras del nombre del producto (sin tildes, sin
caracteres no alfabéticos, rellenado con `X` si el nombre da menos de 3
letras) en mayúsculas + `-` + secuencia de 3 dígitos empezando en `000`,
calculada consultando cuántos productos ya existen con ese mismo prefijo.
Si choca con el índice único de `sku` (condición de carrera entre el
cálculo y el insert), reintenta hasta 5 veces con el siguiente número. El
frontend (`ProductModal.tsx`) **no manda `sku` al crear** — el campo se
muestra de solo lectura al editar un producto existente. No muevas esta
lógica al frontend: la unicidad depende de consultar Mongo justo antes del
insert, con reintento ante colisión.

### 15. `GET /api/admin/products`, `/users`, `/branches`, `/purchases`, `/sales` y `/expenses` paginan desde el backend — no son un array

`listProducts`, `listUsers` y `listBranches` (`adminController.ts`) siguen
todos el mismo patrón: aceptan `page`, `pageSize` (máx. 100, default 20) e
`includeInactive`, y devuelven `{ data, total, page, pageSize, totalPages }`
en vez de un arreglo plano. `includeInactive !== "true"` es el default
(solo activos); mandar `includeInactive: true` es lo único que trae
inactivos. `Inventario.tsx`, `Personal.tsx` y `Sedes.tsx` son los
consumidores de la vista paginada (con su checkbox "Mostrar inactivos/os" y
botones Anterior/Siguiente) y ya manejan ese shape, incluyendo
autocorrección (`if (res.page > res.totalPages) setPage(res.totalPages)`)
si una eliminación deja la página actual vacía. `listProducts` además
acepta un `branchId` opcional — si viene, la respuesta agrega un campo
`branchStock` por producto (stock específico de esa sede, no la suma total)
sin que eso afecte a quien no lo use.

**Ojo con los consumidores que necesitan "todos", no una página:** cualquier
`<select>` que arma sus opciones desde uno de estos tres endpoints (el
selector de sede en `Layout.tsx`/`Topbar.tsx`, el select de sede en
`UserModal.tsx`, el select de sede en `DianConfig.tsx`, el select de
producto en `StockModal.tsx` y en `SaleModal.tsx`) le pasa `{ pageSize: 100
}` explícitamente y lee `res.data` — no hay una llamada "sin paginar" por
separado. Si el catálogo de sedes o productos algún día supera 100
registros, estos selects empezarían a mostrar solo los primeros 100; sube
ese número ahí (no cambies el default del backend) si eso llega a pasar. Si
agregas otro consumidor de cualquiera de estos tres endpoints (o de
`adminApi.listProducts`/`listUsers`/`listBranches`), recuerda leer
`res.data`, no tratar la respuesta como el arreglo directamente.

`GET /api/admin/purchases` (`listPurchasesAdmin`) sigue el mismo patrón
(`page`/`pageSize`/`{data,total,page,pageSize,totalPages}`), con un campo
extra: `totalAmount`, la suma en dinero de **todas** las compras del
filtro (no solo la página actual) — calculada aparte con un
`Purchase.aggregate` porque `Compras.tsx` muestra un total agregado en el
header que tiene que seguir siendo correcto sin importar en qué página
esté el admin. Además de `branchId`/`from`/`to`, ahora acepta `productId`
y `registeredBy` (filtros "Producto"/"Usuario" de `Compras.tsx`) — sus
opciones salen de dos lookups livianos nuevos, `GET
/api/admin/purchases/products` (`listPurchaseProducts`) y `GET
/api/admin/purchases/registrants` (`listPurchaseUsers`), mismo patrón que
`listSaleUsers`: `Purchase.distinct(...)` filtrado solo por sede (no por
los demás filtros ya elegidos) para poblar un `<select>`, no una tabla.
`from`/`to` también se corrigieron para usar `startOfLocalDay`/
`endOfLocalDay` (ver punto 33/24) — antes usaban `new Date(string)` a
secas, el mismo bug de zona horaria ya corregido en `listSales`, que
nadie había replicado acá todavía.

**Bug real encontrado y corregido al agregar esos filtros — `totalAmount`
daba $0 en cuanto se filtraba por sede/producto/usuario**: `$match` en un
pipeline de `aggregate()` NO castea tipos como sí lo hace
`Model.find()`/`countDocuments()` — comparar el string de
`resolveBranchFilter()`/`req.query` contra el `ObjectId` real guardado en
Mongo nunca matchea nada. Este es el mismo gotcha ya conocido y corregido
en `getDashboardMetrics` (ver punto 25 en `admin-frontend/CLAUDE.md`) y en
`createSaleAdmin` (ver punto 37) — pero **nadie lo había replicado en
`listPurchasesAdmin` ni en `listExpenses`** (`Gastos.tsx` tenía exactamente
el mismo bug esperando a que alguien filtrara por sede ahí también). La
corrección en ambos: castear a `new Types.ObjectId(...)` **al construir
`filter`**, antes de usarlo en `find`/`countDocuments`/`aggregate` — los
dos primeros aceptan un `ObjectId` real igual que un string, así que no
hace falta un filtro aparte solo para el `aggregate`. **Si agregas un
`totalAmount`/suma agregada nueva a otro endpoint `list*` que filtre por
`branchId` (u otro campo `ObjectId`), castea el filtro antes del
`aggregate` desde el principio** — no esperes a que alguien filtre por esa
sede específica para descubrirlo.

`GET /api/admin/sales` (`listSales`) también sigue el mismo patrón
(`page`/`pageSize`/`{data,total,page,pageSize,totalPages}`, default 20 por
página) — `Ventas.tsx` es su consumidor, con los mismos botones Anterior/
Siguiente y el mismo reset a página 1 al cambiar cualquier filtro (sede,
estado DIAN, canal, categoría, usuario, método de pago, CUFE/ID, fecha).

**`listSales` ganó `totalAmount`** (mismo campo que `listPurchasesAdmin`/
`listExpenses`, ver arriba), con dos particularidades propias:
1. **Excluye `status: "CANCELLED"`** — el `$match` del `aggregate` es
   `{ ...filter, status: "ACTIVE" }`, no `filter` a secas. Una venta
   cancelada no es dinero real entrando a caja (mismo criterio que
   `getDashboardMetrics`, que también solo suma `status: "ACTIVE"`), así
   que sumarla infla el total con dinero que nunca se cobró. `data`/
   `total` (la tabla y el conteo de paginación) SÍ siguen incluyendo
   canceladas sin cambios — `Ventas.tsx` las muestra con un badge
   "Cancelada" y `opacity-60`, solo el total en dinero las excluye.
2. **El casteo a `Types.ObjectId`** (`branchId`/`cashierId`, ver el bug
   documentado arriba para `listPurchasesAdmin`/`listExpenses`) se aplicó
   acá **desde el principio**, no como corrección posterior — al
   construir `filter` la primera vez, antes de que existiera
   `totalAmount`, ya se sabía del gotcha por los dos casos anteriores. Si
   agregas un `totalAmount` a un endpoint `list*` nuevo, castea los
   campos `ObjectId` del filtro desde el primer commit, no esperes a que
   alguien filtre por una sede específica para descubrirlo.

**`listBranches` ganó un `search` opcional** (nombre, dirección o
teléfono) — mismo patrón de `listSales` (`search` por CUFE/ID): término
recortado, escapado con `term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` y
armado como `$or` de `$regex`/`$options: "i"` sobre los tres campos, sin
`$text` (a diferencia de `listProducts`) porque `Branch` no tiene un
índice de texto y el catálogo de sedes es demasiado pequeño para
justificarlo. `Sedes.tsx` es el único consumidor que lo manda; los demás
consumidores de `listBranches` (los `<select>` de sede en `Layout.tsx`,
`UserModal.tsx`, `DianConfig.tsx`, `StockModal.tsx`, `SaleModal.tsx`,
`CashClosureModal.tsx`, todos con `{ pageSize: 100 }`) simplemente no
mandan `search`, así que quedan sin cambios. Si agregas búsqueda a otro
endpoint `list*` que no tenga ya un índice de texto, replica este mismo
patrón de regex escapado en vez de `$text` — no hace falta declarar un
índice nuevo para un catálogo chico.

`GET /api/admin/expenses` (`listExpenses`) sigue el mismo patrón que
`/purchases` — incluyendo el campo extra `totalAmount` (suma en dinero de
**todos** los gastos del filtro, vía `Expense.aggregate`, no solo la
página actual) — porque `Gastos.tsx` también muestra un total agregado en
el header junto al selector de categoría. Antes de esto, el endpoint
devolvía un arreglo plano con `.limit(500)` y el total se calculaba en el
cliente con `rows.reduce(...)` sobre esas 500 filas — lo cual, además de
no paginar, daba un total incorrecto en cuanto un filtro superaba las 500
filas. `Gastos.tsx` resetea a página 1 al cambiar de sede, categoría o
fecha, igual que el resto de las páginas paginadas.

**`listExpenses` ganó un filtro `from`/`to`** (fecha, mismo `<input
type="date">` enviado como `from`/`to` iguales que en Ventas/Compras) —
vía `startOfLocalDay`/`endOfLocalDay` (ver punto 33/24) desde el
principio, no `new Date(string)` a secas; ya no quedaba ningún endpoint
`list*` con fecha filtrando sin esos helpers para replicar el bug de
zona horaria por descuido.

**`listExpenses` ahora popula `branchId` (`.populate("branchId", "name")`)**
— antes `Expense.find(filter)` devolvía `branchId` como el `ObjectId` sin
resolver, lo cual nunca se había notado porque `Gastos.tsx` no tenía
columna "Sede" que lo necesitara. El filtrado por sede **ya funcionaba**
desde antes de esto (`resolveBranchFilter`/el selector de la topbar ya
alimentaba `filter.branchId`, ver el bug de casteo documentado arriba) —
lo que faltaba era únicamente poder mostrar el nombre de la sede en la
tabla, no la lógica de filtrado en sí.

*(Nota frontend: `admin-frontend/CLAUDE.md` recuerda "leer `res.data`, no
la respuesta directa" para cualquier `<select>` que consuma uno de estos
endpoints sin paginar.)*

`GET /api/admin/cash-closures` (`listCashClosuresAdmin`, en
`cashClosureController.ts`) sigue el mismo patrón de paginación que los
anteriores, sin `totalAmount` (no hay un monto único que sumar — la fila
trae varios: base efectivo, base Nequi, declarado, diferencia). Ya
aceptaba `from`/`to` desde antes, pero con el mismo bug de zona horaria
que `listSales`/`listPurchasesAdmin` (`new Date(string)` a secas) — nadie
lo había notado porque `FinanzasCaja.tsx` nunca mandaba esos parámetros,
así que el filtro llevaba tiempo sin ejercitarse en la práctica. Se
corrigió a `startOfLocalDay`/`endOfLocalDay` (punto 33/24) y se agregó
`cashierId` (filtro nuevo, sobre `CashClosure.cashierId` directo — no
necesita casteo a `Types.ObjectId` porque este endpoint no tiene
`aggregate()`, solo `find`/`countDocuments`, que sí toleran un string).

### 18. ADMIN nunca tiene sede; MANAGER siempre queda restringido a la suya

`User.branchId` (`backend/src/models/User.ts`) es requerido condicionalmente
según el rol (`required: function() { return this.role !== "ADMIN" }`):
un `ADMIN` nunca se asigna a una sede (ve todas), mientras que `MANAGER` y
`CASHIER` sí la necesitan. `createUser` (`adminController.ts`) refuerza esto
del lado del servidor — limpia `branchId` si el rol es `ADMIN` y devuelve 400
si falta en `MANAGER`/`CASHIER` — no confíes solo en la validación de
`UserModal.tsx` en el frontend.

Para que un gerente **solo vea información de su propia sede**, todo
controlador `list*` que antes leía `req.query.branchId` directo ahora pasa
por `resolveBranchFilter(req)` (exportado desde `adminController.ts`,
importado también en `purchaseController.ts`): si `req.admin.role ===
"MANAGER"`, ignora cualquier `branchId` que mande el cliente y usa
`req.admin.branchId` (el de su JWT); si es `ADMIN`, mantiene el
comportamiento anterior (filtro opcional por query param, o todas las sedes
si no manda ninguno). **Si agregas un nuevo endpoint `list*` que filtra por
sede, usa `resolveBranchFilter(req)` en vez de leer `req.query.branchId`
directamente** — de lo contrario un gerente podría ver datos de otra sede
con solo cambiar el query param.

`listUsers` además popula `branchId` a `{ _id, name }` vía
`.populate("branchId", "name")` y expone un campo plano `branchName` en la
respuesta (no un objeto anidado `branch`) — así `Personal.tsx` puede
mostrarlo directamente en la columna "Sede" sin un join en el cliente. Si
agregas otro consumidor de `GET /api/admin/users`, espera ese shape
(`branchId` como string u `null`, más `branchName` como string u `null`).

**`listUsers` ganó `role` y `search`** (filtros "Rol"/buscador de
`Personal.tsx`). `role` es un `filter.role = role` directo (sin casteo —
es un string enum, no un `ObjectId`). `search` busca por nombre O correo,
mismo patrón de regex escapado + case-insensitive que `listBranches`
(nombre/dirección/teléfono): `filter.$or` con `$regex`/`$options: "i"`
sobre `name` y `email`, sin `$text` por la misma razón (catálogo de
usuarios de una sede, no lo bastante grande para justificar un índice).
Ambos se combinan con el filtro de sede/`includeInactive` existente sin
casos especiales.

**Gotcha real ya corregido — índice sparse + `""` sigue chocando:**
`User.email` tiene `unique: true, sparse: true` porque solo ADMIN/MANAGER
tienen correo (los cajeros no). Un índice sparse ignora documentos donde
el campo está **ausente**, pero `""` (string vacío) sigue siendo un valor
real para Mongo — no lo ignora. `UserModal.tsx` dejaba `email: ""` en el
estado del formulario para el rol CASHIER (que ni siquiera muestra ese
campo), y `createUser`/`updateUser` lo mandaban tal cual a Mongo — el
segundo cajero creado sin correo chocaba contra el primero con
`E11000 dup key: { email: "" }`. La corrección fue en dos capas: el
backend normaliza `email: email || undefined` (nunca `""`) antes de
`User.create`, y usa `$unset` en vez de `$set` en `updateUser` cuando el
campo viene vacío (un `$set` con `undefined` no borra el campo, Mongoose
lo descarta del update); el frontend además ya no manda `email` en
absoluto cuando `role === "CASHIER"`. **Si agregas otro campo `unique,
sparse` opcional, nunca dejes que llegue como `""` al modelo** — normaliza
a `undefined` en el controlador, no confíes en que el frontend nunca lo
mande vacío.

**Validación de PIN de cajero (sin punto numerado propio):** `createUser`/
`updateUser` también verifican, para `role === "CASHIER"`, que el PIN no
esté ya en uso por otro cajero **activo de la misma sede**
(`isPinTakenInBranch`, en `adminController.ts`) — el PIN se guarda hasheado
(`pin: { select: false }` en el modelo, bcrypt vía `comparePin`), así que
no se puede buscar por igualdad directa: se traen los candidatos
(`{ branchId, role: "CASHIER", active: true }`, el mismo universo que usa
`posLogin` para resolver el PIN al iniciar sesión) y se comparan uno por
uno. Responde `409` si hay colisión. Si dos cajeros activos de la misma
sede compartieran PIN, `posLogin` haría un match ambiguo (toma el primero
que matchee al hacer `bcrypt.compare` en un loop) — por eso la validación
tiene que ser fiel a ese mismo filtro.

*(Nota frontend: `admin-frontend/CLAUDE.md` señala que `Layout.tsx` fuerza
`selectedBranch` a la sede del gerente al montar, y que `Topbar.tsx`
reemplaza el `<select>` de sede por texto fijo para MANAGER — la fuente de
verdad de la restricción sigue siendo `resolveBranchFilter` acá arriba.)*

### 21. Sincronización en tiempo real con Google Sheets — cola + worker separado, igual que DIAN

`docs/GOOGLE_SHEETS_INTEGRATION.md` tiene el detalle completo (Apps
Script a desplegar, payloads exactos, tabla de qué evento dispara qué
acción) — acá solo el resumen de arquitectura para no repetirlo:

- **Cola separada** (`backend/src/queues/sheetsQueue.ts`, `sheets-sync`) +
  **worker separado** (`backend/src/workers/sheetsWorker.ts`, `npm run
  worker:sheets`, su propio servicio en `docker-compose.yml`) — mismo
  principio que el worker DIAN (punto 5): nunca corre dentro de
  `server.ts`. A diferencia del worker DIAN, este NO necesita conexión a
  Mongo — los jobs llevan el payload ya resuelto (nombres de sede/usuario,
  no ids), así que solo habla con Redis y con el webhook de Apps Script.
- **`backend/src/utils/sheetsSync.ts`** expone `syncInventoryToSheets`,
  `logSaleToSheets`, `logPurchaseToSheets`, `logExpenseToSheets`,
  `logCashClosureToSheets` — todas se llaman **fire-and-forget**
  (`.catch(err => console.error(...))`, nunca `await`) desde el
  controlador correspondiente, DESPUÉS de que la operación real ya se
  guardó en Mongo, siguiendo el mismo principio que el enqueue de DIAN
  (punto 2): un fallo acá nunca debe afectar la operación real.
- **`GOOGLE_SHEETS_WEBHOOK_URL`** (la URL `/exec` del Apps Script
  desplegado) solo hace falta en el proceso del **worker**, no en el API —
  el API solo encola.
- Reintentos con backoff exponencial (5 intentos, igual que DIAN) — Apps
  Script bound a un Spreadsheet tiene límites reales de concurrencia
  (`SpreadsheetApp` serializa escrituras simultáneas), así que un job
  puede fallar 2-3 veces por timeout antes de completar; es esperado, no
  un bug. A diferencia de DIAN, esta cola **no tiene job de
  reconciliación** — si se agotan los 5 intentos, ese job queda `failed`
  sin reintento automático posterior (Mongo sigue siendo la fuente de
  verdad; Sheets es un espejo de reporting, no un sistema de registro).

### 24. `utils/dateRange.ts` — único lugar para convertir un `<input type="date">` a inicio/fin de día

`startOfLocalDay(dateStr)` / `endOfLocalDay(dateStr)` existen por un bug
real que ya pasó dos veces (en `getDashboardMetrics` y en
`reportController.ts`, antes de que existiera este helper compartido):
`new Date("2026-08-24")` parsea el string como medianoche **UTC**, pero
`Date.prototype.setHours()` siempre opera en hora **local** — mezclar
ambas para calcular un "fin de día" (`new Date(str); d.setHours(23,59,59,999)`)
da un rango de horas equivocado en cualquier zona horaria con offset
negativo (Colombia, UTC-5): el límite resultante cae casi un día completo
antes de lo esperado, así que ventas/gastos reales de la tarde/noche
quedan silenciosamente fuera del filtro — sin ningún error, solo
resultados vacíos o incompletos que parecen "no hay datos". Si agregas un
filtro nuevo de `from`/`to` en el backend, usa estas dos funciones — no
repitas `new Date(string)` + `setHours()` a mano.

**Reescrito por completo (ya no usa el constructor multi-argumento `new
Date(y, m-1, d, ...)`)** — ver punto 33 (raíz) para el porqué: ese
constructor resuelve en la zona horaria del PROCESO de Node (el SO del
contenedor/host donde corre el backend), no necesariamente Colombia, y
nada en este proyecto fijaba eso. La versión actual construye el `Date`
con un string ISO que lleva el offset `-05:00` puesto a mano
(`` `${dateStr}T00:00:00.000-05:00` ``) — correcto sin importar en qué
timezone corra el proceso. El archivo también exporta ahora
`COLOMBIA_TIME_ZONE`, `COLOMBIA_UTC_OFFSET`, `getTodayColombiaDateString()`
y `getStartOfTodayColombia()` — este último reemplaza cualquier `new
Date(); d.setHours(0,0,0,0)` que calculara "el inicio de hoy" (ver punto
33 raíz), que tenía el mismo problema.

Un caso especial dentro de `getDashboardMetrics`: el `cursor` que arma la
etiqueta de cada día en la vista "por día" del timeline (rango multi-día)
usa los getters/setters **UTC** de `Date` (`getUTCFullYear`/`getUTCDate`/
`setUTCDate`), no los "locales" — porque `start`/`end` ya son instantes
que representan medianoche/fin de día en Bogotá (05:00/04:59:59 UTC), así
que leerlos en UTC da el día correcto de Bogotá sin importar en qué
timezone corra el proceso.

También: el widget de "Comportamiento de ventas" de `getDashboardMetrics`
grafica las **24 horas** del día (00:00–23:00), no solo 05:00–23:00 como
tenía antes — una venta real ocurrida entre medianoche y las 5am (hora
Bogotá) quedaba fuera del loop de graficado aunque sí contara en el
resumen, mostrando "No hay ventas registradas" con el resumen de al lado
mostrando totales reales. Si vuelves a acotar ese rango de horas, ten en
cuenta que le vuelve a introducir ese mismo bug.

### 34. Ventas por DELIVERY_APP (Rappi/DiDi) nacen `PENDING_PAYMENT` — es Cuentas por Cobrar hasta que el agregador liquida

Rappi/DiDi cobran al cliente y le depositan el dinero a la panadería días
después, a diferencia de CASH/NEQUI/CARD que se dan por cobrados el mismo
día. `Sale.paymentStatus` (`"COMPLETED" | "PENDING_PAYMENT"`, con
`settlementDate?: Date`, ver `backend/src/models/Sale.ts`) modela esto.

**El trigger es `paymentMethod === "DELIVERY_APP"`, NO `orderType ===
"DIDI"`** — ojo con esta distinción, es una trampa real: `orderType`
(`POS_COUNTER`/`RAPPI`/`DIDI`/`DELIVERY_LOCAL`) es el *canal* por el que
llegó el pedido, y `paymentMethod` (`CASH`/`NEQUI`/`CARD`/`DELIVERY_APP`) es
*cómo se cobró* — son campos independientes, una venta con `orderType:
"DIDI"` perfectamente podría tener `paymentMethod: "CASH"` (el domiciliario
cobra en efectivo contra entrega) y esa sí se cobró el mismo día, no debería
quedar `PENDING_PAYMENT`. Este punto se decidió explícitamente así (no por
descuido) tras confirmar que ni Rappi ni DiDi existen como valor de
`paymentMethod` — solo `DELIVERY_APP` cubre ambos agregadores como forma de
pago.

- **`resolvePaymentStatus(paymentMethod)`** (exportada desde
  `backend/src/models/Sale.ts`, junto al modelo) es el único punto de
  verdad: `"DELIVERY_APP"` → `"PENDING_PAYMENT"`, cualquier otro valor →
  `"COMPLETED"`. La usan los 3 sitios que llaman `Sale.create`
  (`posController.createSale`, `posController.syncOfflineSales`,
  `adminController.createSaleAdmin`) para fijar el valor inicial, y
  `adminController.updateSaleAdmin` la vuelve a llamar si el admin edita
  `paymentMethod` a un valor distinto del que ya tenía (comparación
  explícita, no solo "si vino en el body" — si no, reenviar el mismo
  formulario sin tocar ese campo resetearía `paymentStatus`/
  `settlementDate` sin necesidad). Si vuelve a un método que no es
  `DELIVERY_APP`, limpia `settlementDate` (la liquidación anterior, si la
  hubo, ya no aplica).
- **Confirmación manual, no hay forma automática de saberlo**: `PATCH
  /api/admin/sales/:id/confirm-payment` (`confirmSalePayment` en
  `adminController.ts`, `requireRole("ADMIN", "MANAGER")`, mismo chequeo de
  sede que `cancelSaleAdmin`/`updateSaleAdmin` para MANAGER) pone
  `paymentStatus: "COMPLETED"` y `settlementDate: new Date()`. Rechaza con
  400 si la venta no está `PENDING_PAYMENT` (evita reconfirmar o confirmar
  una venta que nunca lo estuvo). No hay integración con Rappi/DiDi ni con
  el banco — un humano lo confirma al ver el depósito reflejado en el
  extracto bancario.
- **El arqueo de turno del cajero (`computeShiftFinancials`,
  `cashClosureController.ts`) YA excluía `DELIVERY_APP` del efectivo/Nequi
  esperado, sin necesidad de ningún cambio para este punto**: agrupa ventas
  por `paymentMethod` en 4 baldes disjuntos (`cashSales`/`cardTotal`/
  `nequiTotal`/`appsTotal`), y `systemCalculatedCash`/`systemCalculatedNequi`
  (lo que el cajero cuenta físicamente al cerrar turno, ver punto 29 en
  `admin-frontend/src/cajero/CLAUDE.md`) solo usan los baldes de
  `CASH`/`NEQUI` — `appsTotal` nunca entra ahí. No lo "arregles" pensando
  que falta excluirlo; ya estaba excluido antes de que existiera
  `paymentStatus`, porque el efectivo/Nequi físico nunca incluyó ventas de
  apps para empezar.
- **Google Sheets**: `logSaleToSheets` (`utils/sheetsSync.ts`) manda
  `paymentStatus` en el payload de `LOG_TRANSACTION`, y el `Code.gs` de
  referencia (`docs/GOOGLE_SHEETS_INTEGRATION.md`) escribe una columna
  `Payment_Status` en `OPERATIONAL_LOGS`. Como esa pestaña es append-only
  (ver punto 22 en `admin-frontend/CLAUDE.md`), confirmar el pago después
  con el endpoint de arriba **no reescribe** la fila ya loggeada — el
  sheet solo refleja el estado al momento de crearse la venta, no el
  estado actual. Si en algún momento se necesita que Sheets refleje
  confirmaciones posteriores, hay que decidir aparte cómo (¿una segunda
  fila de "ajuste"? ¿una pestaña nueva de conciliación?) — no está
  resuelto, y no se inventó un mecanismo para esto sin que se pidiera
  explícitamente.

*(La UI de "Confirmar Pago" — badge en `Ventas.tsx`, ítem del `ActionsMenu`
— vive en `admin-frontend/CLAUDE.md`, ya que es exclusiva del panel admin,
a propósito no está en `/cajero/facturas`.)*

### 35. Factura Electrónica Nominal también es opcional para el cliente — ver `admin-frontend/src/cajero/CLAUDE.md`

REQ-10 (tope de consumidor final, `dianService.requiresNominalInvoice`)
sigue igual: `posController.createSale` rechaza con 422
`REQUIERE_DATOS_CLIENTE` si la venta supera el tope y no llega `customer`.
Lo único que cambió del lado del backend: `invoiceType` ahora se decide con
`wantsNominalInvoice = requiresNominal || Boolean(customer?.document)` en
vez de solo `requiresNominal` — la sola presencia de `customer.document`
(sin importar si fue por obligación o porque el cliente lo pidió
voluntariamente desde el POS) ya es señal suficiente de que se quiere
factura nominal. El flujo completo (modal de sí/no, captura de datos) es
puramente de la zona de cajero — ver ese archivo para el detalle.
`syncOfflineSales` y `adminController.createSaleAdmin` no se tocaron para
esto (ver esa entrada para el porqué).

### 37. `createSaleAdmin` categoriza `SPECIAL`/`REGULAR` según un tope diario — solo si la sede es `dianResponsible`

Lógica exclusiva de `POST /api/admin/sales` (no existe en
`posController.createSale`, el flujo del cajero): `MAX_GROUP_1 = 509000`
y `THIRTY_MINUTES = 2 * 60 * 1000` son constantes locales de
`createSaleAdmin`, no importadas de `dianService` — si el negocio quiere
que el tope se mantenga igual al `DIAN_TOPE_CONSUMIDOR_FINAL` de
`dianService.requiresNominalInvoice` (punto 35), hay que actualizar
ambas a mano, no están enlazadas.

- **Todo el bloque solo corre si `branchInfo.dianResponsible === true`**
  (el checkbox "Responsable de declarar ante la DIAN" de
  `BranchModal.tsx`, ver `Branch.ts`). Si la sede NO es `dianResponsible`,
  la venta siempre queda `category: "REGULAR"` y **nunca se encola para
  emisión DIAN** — el segundo `if` (justo antes de
  `enqueueSaleForDianEmission`) también exige
  `branchInfo.dianResponsible === true`. **Esto contradice el comentario
  actual en `Branch.ts`** (`"dato informativo, no gatea la emisión"`) —
  ese comentario quedó desactualizado: el campo empezó como
  puramente informativo pero el código de acá ya lo usa para gatear tanto
  la categorización como el encolado real a DIAN. Si tocas cualquiera de
  los dos lados, actualiza el otro para que no queden contradictorios.
- Cuando sí aplica: suma el total de ventas `category: "SPECIAL"` de HOY
  (hora Bogotá, `getStartOfTodayColombia()`) en esa sede vía
  `Sale.aggregate` — con `branchId` casteado a mano a `ObjectId` en el
  `$match` (mismo gotcha de `getDashboardMetrics`: `$match` no castea
  como sí lo hace `Model.find()`) — y calcula `hasSpace = (sumaHoy +
  total) < MAX_GROUP_1`. También exige `thirtyMinutesPassed` desde la
  última venta `SPECIAL` de esa sede (`Sale.findOne`, mismo scope por
  `branchId`). Solo si **ambas** son ciertas, `category = "SPECIAL"` —
  si no, `"REGULAR"`. La venta se crea siempre, con `category` ya
  decidido; `invoiceType` queda hardcodeado a `"POS_DOC"` sin relación
  con esto (el bloque que lo decidía según `requiresNominal` está
  comentado/deshabilitado, ver punto 19 en `admin-frontend/CLAUDE.md`).
- **Bug real pendiente, no corregido a propósito sin que se pida**:
  `THIRTY_MINUTES = 2 * 60 * 1000` son **2 minutos**, no 30, pese al
  nombre de la constante. Si el negocio de verdad quiere un cooldown de
  30 minutos entre ventas `SPECIAL`, hay que cambiarlo a `30 * 60 *
  1000`.
- El `hasSpace && thirtyMinutesPassed` que gatea el `enqueueSaleForDianEmission`
  ya implica `dianResponsible === true` (esas dos variables solo pueden
  ser `true` si el bloque de arriba corrió) — repetir
  `branchInfo.dianResponsible === true` en ese segundo `if` no cambia el
  comportamiento, es solo una condición explícita/defensiva, no un bug.

### 38. Gastos: editar/eliminar es un borrado real, sin reversar nada — a propósito distinto de Sale/Purchase

`updateExpense`/`deleteExpense` (`adminController.ts`, `PUT`/`DELETE
/api/admin/expenses/:id`, `requireRole("ADMIN", "MANAGER")`, mismo chequeo
`branchId` para MANAGER que en Sale/Purchase) no existían hasta ahora —
`Gastos.tsx` solo tenía crear+listar. Antes de copiar el patrón de
Purchase o Sale para otra entidad nueva, ten en cuenta que **`Expense` es
deliberadamente más simple que ambos**:

- **`deleteExpense` es un `deleteOne()` de verdad, no un soft-delete.**
  `Sale` tiene `status: "CANCELLED"` (punto 22 en `admin-frontend/
  CLAUDE.md`) porque cancelar una venta necesita dejar rastro contable y
  quizás revertir stock; `Purchase` valida disponibilidad de stock antes
  de borrar (punto 16) porque agregó `ProductStock` al crearse. `Expense`
  no tiene ninguno de los dos problemas — no descuenta/agrega inventario,
  y no hay ningún reporte que dependa de "ver gastos eliminados" — así
  que no se inventó un `status`/`active` que el modelo nunca tuvo. Si en
  el futuro se necesita un historial de gastos eliminados, es una
  decisión de negocio nueva, no algo que ya esté a medio hacer.
- **`updateExpense` es un patch simple de `category`/`concept`/`amount`**
  — sin el problema de `PurchaseEditModal`'s `quantity`/stock-delta,
  porque `Expense` no tiene `productId` ni cantidad. Única validación
  extra: `amount`, si viene, debe ser `> 0` (mismo chequeo que
  `ExpenseModal.tsx` ya hacía en el frontend al crear, replicado acá para
  no confiar solo en el cliente).
- **No hay re-sincronización a Google Sheets en ninguno de los dos** —
  mismo motivo que en el punto 34 (DiDi) y el punto 22 (edición de
  ventas): `OPERATIONAL_LOGS` es append-only (punto 21), así que la fila
  que `logExpenseToSheets` ya escribió al crear el gasto sigue mostrando
  los datos originales después de editar o eliminar. Si esto llega a
  importar de verdad (ej. un gasto se borra por error de captura), la
  reconciliación hoy es manual, revisando Mongo contra el Sheet.
- **Frontend**: `ExpenseEditModal.tsx` (nuevo, `admin-frontend/src/
  components/`) sigue el mismo layout que `PurchaseEditModal.tsx` (header
  con ✕, mismo `fixed inset-0 ... !m-0`) pero sin la lógica condicional de
  stock. Su `<select>` de categoría **sí incluye "Caja menor"
  (`PETTY_CASH`)**, a diferencia del `ExpenseModal.tsx` de creación (que
  la excluye a propósito — la caja menor solo se crea desde el arqueo del
  cajero, ver `cajero/components/modals/ExpenseModal.tsx`, una copia
  intencional distinta, punto 12 en `admin-frontend/src/cajero/
  CLAUDE.md`): un gasto existente ya puede tener esa categoría, y
  omitirla del `<select>` de edición dejaría esa opción huérfana o
  forzaría un cambio de categoría no pedido con solo abrir el modal para
  editar el monto. `Gastos.tsx` agregó la columna "Acciones" al
  `DataTable.tsx` con `stickyRight: true` (mismo prop que Sedes/Compras/
  Ventas, punto 36) — el resto de la página (header, paginación) no se
  tocó para responsividad en este cambio, sigue pendiente igual que antes.
- **De paso se corrigió un bug real de zona horaria** (punto 33): la
  columna "Fecha" de `Gastos.tsx` hacía `new Date(r.createdAt).
  toLocaleString("es-CO")` sin `timeZone` — el mismo patrón que motivó
  todo ese punto. Ahora usa `formatDateTime` de `utils/timezone.ts`, igual
  que `Compras.tsx`/`Ventas.tsx`.

### 40. "Olvidé mi contraseña" (ADMIN/MANAGER) — token de un solo uso, correo por Resend (API HTTP) tras confirmar que Render bloquea SMTP saliente

Solo ADMIN/MANAGER pueden recuperar contraseña — un cajero no tiene
`email`/`password` en absoluto (usa PIN, ver `posLogin`), así que ni
siquiera puede llegar a este flujo. Dos endpoints nuevos en
`authController.ts`, registrados en `adminRoutes.ts` **antes** de
`router.use(requireAdminAuth)` (línea ~61, junto a `/auth/login` y
`/auth/logout`) — son los únicos, además de login, que no requieren la
cookie `admin_token`:

- `POST /api/admin/auth/forgot-password` `{ email }` (`forgotPassword`)
- `POST /api/admin/auth/reset-password` `{ token, password }`
  (`resetPassword`)

**El token de recuperación es independiente del JWT de sesión** — no
reutiliza `jwt.sign`/`JWT_SECRET` de ningún modo. Es un valor aleatorio
crudo (`crypto.randomBytes(32).toString("hex")`) que se manda por correo
y **nunca se persiste tal cual**: solo su hash SHA-256
(`resetPasswordTokenHash`, campo nuevo en `User.ts`, `select: false`
igual que `password`/`pin`) se guarda junto a `resetPasswordExpires`
(ahora + 1 hora). `resetPassword` recibe el token crudo del link, lo
hashea igual (`crypto.createHash("sha256")...`) y busca por ese hash +
`resetPasswordExpires: { $gt: new Date() }` — así un volcado de la base
de datos nunca alcanza para reconstruir un link válido, solo el correo
del usuario lo tiene. Al resetear con éxito, ambos campos se limpian
(`= undefined`) — el token es de un solo uso, no se puede reutilizar el
mismo link dos veces (verificado: el segundo intento con el mismo token
devuelve 400 "El enlace es inválido o ya expiró", el mismo mensaje que un
token que nunca existió — no hay forma de distinguir "ya usado" de
"inválido" desde afuera).

**Protección contra enumeración de correos**: `forgotPassword` responde
exactamente el mismo mensaje genérico (`"Si el correo existe, se envió un
enlace de recuperación"`) exista o no una cuenta con ese correo — nunca
un 404 ni un mensaje distinto. Si el usuario existe, sí se espera
(`await`) el envío real del correo antes de responder, y **si el SMTP
falla, se propaga un 500 real** (`"No se pudo enviar el correo. Intenta
más tarde."`) — a diferencia de la sincronización con Google Sheets
(punto 21, "best-effort", fire-and-forget), acá el usuario hizo clic
esperando un correo, así que un error de configuración SMTP debe ser
visible, no silencioso. Esto no rompe la protección contra enumeración:
un 500 por SMTP mal configurado es indistinguible de "el envío tardó" y
ocurre igual sin importar qué correo se mande — la única fuga posible
sería una diferencia de tiempo si el correo no existe (respuesta
inmediata) vs. si existe (espera al SMTP), un riesgo menor que este
proyecto no intentó mitigar (no hay una razón para pensar que alguien
vaya a cronometrar respuestas de login de un panel administrativo interno
de una sola cadena de panaderías).

**Correo real vía `backend/src/utils/mailer.ts`** (nuevo archivo,
`nodemailer` — nueva dependencia, antes no existía ninguna librería de
correo en el proyecto): un solo `nodemailer.createTransport(...)` a nivel
de módulo, leyendo `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/
`SMTP_PASS`/`SMTP_FROM` de `process.env` (mismo patrón ad-hoc de env vars
que el resto del backend — no hay un `config.ts` central que las valide).
`createTransport` no conecta de inmediato (nodemailer es perezoso hasta
`sendMail`), así que es seguro que el módulo se cargue aunque esas
variables estén vacías en desarrollo — simplemente el primer
`forgotPassword` real fallará con el 500 de arriba, en vez de romper el
arranque del servidor. Pensado para el correo empresarial del negocio vía
**SMTP de Gmail**, pero no hay nada específico de Gmail en el código —
son variables SMTP genéricas, sirven con cualquier proveedor.

**Gotcha real de Gmail, para cuando se conecte el correo real**:
`SMTP_PASS` **debe** ser una "contraseña de aplicación" de 16 caracteres
generada desde la cuenta de Google (requiere verificación en dos pasos
activada primero) — la contraseña normal de la cuenta de Gmail **no
funciona** para SMTP AUTH (Google la rechaza), y el error que da
nodemailer en ese caso no es obvio si no se conoce este requisito de
antemano. Valores esperados: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`,
`SMTP_SECURE=true`.

**`FRONTEND_URL` es una variable de entorno nueva** (no existía ninguna
"URL del frontend" en el backend antes de esto — lo más cercano era
`CORS_ORIGIN`, que es una lista de orígenes permitidos para CORS, no una
URL única para armar links) — se usa para construir
`${FRONTEND_URL}/reset-password?token=...` en el cuerpo del correo (y
también el logo del correo, ver más abajo), default `http://localhost:5174`
si no está definida. Agregada a `backend/.env` y al bloque `environment`
del servicio `backend` en `docker-compose.yml`, junto a las `SMTP_*` —
**no existe un `backend/.env.example`** en este repo (solo
`admin-frontend/.env.example`) para mantener sincronizado; si en algún
momento se crea uno, agregar estas variables ahí también.

**Bug real de producción, encontrado ya con el negocio conectado a
Gmail real — el SMTP de Gmail queda bloqueado en Render.** Ocurrió en dos
etapas:
1. `ENETUNREACH` conectando a `smtp.gmail.com` — Render no rutea IPv6
   como salida real, pero nodemailer resuelve DNS con una heurística
   propia (`isFamilySupported`, basada en escanear
   `os.networkInterfaces()` del proceso, ver `mailer.ts`) que en el
   contenedor de Render concluye que IPv4 no vale la pena intentar, así
   que solo terminaba resolviendo/usando la dirección IPv6 de Gmail. Se
   corrigió resolviendo la IPv4 a mano con `dns.promises.resolve4()` y
   pasándosela a nodemailer como `host` ya literal (`net.isIP(...)` true
   hace que nodemailer se salte toda su lógica de resolución propia) —
   detalle completo en los comentarios de `mailer.ts`.
2. Con eso corregido, la conexión IPv4 al puerto 465 pasó a colgarse
   hasta `ETIMEDOUT` (nunca un rechazo inmediato) — el patrón típico de
   un firewall de salida que descarta el tráfico en silencio, no de un
   problema de ruteo. **Render bloquea los puertos SMTP salientes
   estándar (465/587/25) a nivel de plataforma, para evitar que su
   infraestructura se use para spam** — esto no es arreglable desde el
   código de la app, ningún ajuste de nodemailer/sockets lo resuelve,
   confirmado tras agotar las opciones a nivel de aplicación.

**La solución real: dejar de usar SMTP directo y mandar el correo por
una API HTTP** (puerto 443, que ningún host bloquea) — `backend/src/
utils/mailerResend.ts` (nuevo archivo, SDK oficial `resend` — nueva
dependencia) usando Resend. **Este es ahora el `sendPasswordResetEmail`
activo** — `authController.ts` importa de `./mailerResend`, no de
`./mailer`. `mailer.ts` (SMTP/nodemailer, con la corrección de IPv4 ya
aplicada) **se dejó intacto a propósito, sin borrar** — sigue siendo
código válido y funcional (útil si el negocio cambia de proveedor de
correo a uno que sí permita SMTP saliente, o si se despliega en un host
sin este bloqueo); para volver a usarlo, el único cambio es el import en
`authController.ts`. Mismo patrón de "probar y dejar la alternativa
intacta" que ya se sigue en otras partes del proyecto (ver el patrón de
`src/cajero/` duplicado, aunque acá es dos implementaciones alternativas
de la misma función, no una copia estructural).

Variables nuevas: `RESEND_API_KEY` (dashboard de Resend > API Keys) y
`RESEND_FROM` (opcional — sin dominio propio verificado en Resend, debe
quedar vacío, lo que hace que `mailerResend.ts` use su remitente de
prueba `onboarding@resend.dev`). **Gotcha real de la cuenta de Resend en
modo de prueba (sin verificar dominio): solo permite mandar correos a la
dirección de correo con la que se creó la cuenta de Resend, a cualquier
otro destinatario le falla** — suficiente para confirmar que el envío por
HTTP funciona (lo cual se verificó así, en producción, con el token
crafteado a mano contra la base real), pero no sirve para usuarios reales
hasta verificar un dominio propio en el dashboard de Resend (agrega unos
registros DNS SPF/DKIM) — con eso se levantan ambas restricciones
(remitente genérico y destinatario único).

**Logo del negocio en el correo** — `mailerResend.ts`/`mailer.ts`
arman `LOGO_URL` como `${FRONTEND_URL}/img/logo-santi-trimmed.png`, el
mismo PNG que ya sirve el frontend como asset estático público (el mismo
que usa `Login.tsx`/`AuthShell.tsx`, ver `admin-frontend/CLAUDE.md`) —
**referenciado por URL, no adjunto ni copiado al backend**: el correo es
HTML con un `<img src="...">` normal, así que depende de que
`FRONTEND_URL` sea la URL real y pública del frontend desplegado. Con el
default de desarrollo (`http://localhost:5174`), el logo simplemente no
carga en un cliente de correo real (nadie fuera de la máquina de
desarrollo puede pedirle una imagen a su propio `localhost`) — el resto
del correo sigue funcionando igual, y el `alt="Mecatos el Santi"` queda
como texto de respaldo si el cliente de correo bloquea imágenes remotas
por defecto (comportamiento normal de Gmail/Outlook hasta que el
destinatario elige "mostrar imágenes"). Si se agrega otro correo
transaccional a futuro que también necesite el logo, reutiliza
`LOGO_URL` en vez de armar la URL de nuevo en un tercer archivo.

**Bug real encontrado y corregido — `LOGO_URL` apuntando al `.webp` en vez
del `.png` se veía roto en el correo real:** alguien cambió esta URL a
`logo-santi-trimmed.webp` (el archivo más liviano, el que sí usa la web
para el logo animado de `LogoLoader.tsx`) — en el navegador WebP funciona
sin problema, pero en un cliente de correo real el logo llegó con bandas
de color y artefactos en vez del logo limpio (confirmado con una captura
real del correo de recuperación de contraseña). No fue un error de carga
(el `<img>` sí "cargaba", solo se veía mal) — varios clientes de correo
(Outlook de escritorio en particular, y algunos proxies de imágenes de
webmail) no decodifican WebP correctamente. Mismo tipo de límite ya
encontrado con `pdfkit`/`exceljs` al generar los reportes (punto 56 de
`admin-frontend/CLAUDE.md`) — ahí WebP directamente no funciona (tira
error), acá "funciona" pero se ve mal, una variante más traicionera del
mismo problema porque no hay ningún error que lo delate. Revertido al
`.png` — si en el futuro alguien vuelve a "optimizar" este `LOGO_URL` a
WebP por su tamaño más chico, no lo hagas: para HTML de correo, el `.png`
es el único formato verificado que se ve bien en todos los clientes.

### 41. Fotos de producto migraron de disco local a Cloudinary — `utils/imageProcessing.ts` ya no existe

**Antes**: `uploadController.ts` (`uploadProductImage`, `POST
/api/admin/uploads/product-image`) recibía el archivo en memoria
(`imageUploadMiddleware`, Multer con `memoryStorage()`, sin cambios por
esta migración), lo procesaba con `sharp` (`utils/imageProcessing.ts`,
`optimizeAndSaveImage()`: resize a 800×800 + conversión a WebP) y lo
escribía en `backend/uploads/products/<uuid>.webp`, sirviéndolo después
vía `express.static("/uploads", ...)` en `app.ts`. **Ahora**: el mismo
buffer se sube directo a Cloudinary (`utils/cloudinary.ts`, nuevo
archivo, SDK oficial `cloudinary` — nueva dependencia) vía
`cloudinary.uploader.upload_stream(...)`, con el resize/conversión a
WebP hechos por Cloudinary del lado suyo (`transformation: [{width:800,
height:800, crop:"fill"}, {fetch_format:"webp", quality:"auto:good"}]`,
mismo criterio de tamaño que `sharp` usaba antes) — la respuesta trae
`secure_url` (siempre HTTPS), que es lo que se guarda tal cual en
`Product.imageUrl`. `utils/imageProcessing.ts` se **eliminó por
completo** (nada más lo usaba, ver el detalle abajo) y `sharp` se
desinstaló del `package.json` (no queda ningún consumidor en el
backend).

**Por qué el cambio**: el comentario que ya existía en `app.ts` sobre
"filesystem efímero (Railway/Render/Heroku) pierde estos archivos en cada
redeploy" dejó de ser una advertencia teórica — Cloudinary resuelve eso
de raíz para cualquier foto subida de ahora en adelante, sin depender de
qué plataforma termine alojando el contenedor.

**Alcance de la migración — solo fotos de producto, nada de "recibos de
compra"**: los comentarios viejos en `upload.ts`/`imageProcessing.ts`/
`app.ts` mencionaban un supuesto uso compartido con recibos de compra del
cajero (`purchaseController.ts`) — **investigado y confirmado que esa
segunda mitad nunca existió en código**: `createPurchase`
(`purchaseController.ts`) no lee `req.file` en ningún punto, no hay
`imageUploadMiddleware` en la ruta `POST /api/pos/purchases`
(`posRoutes.ts`), y `Purchase.receiptImageUrl` (el campo que sí existe en
el modelo) nunca se popula desde ese controlador. Era documentación
aspiracional de un diseño que no se llegó a implementar, no código real
que esta migración tuviera que preservar. Los tres comentarios stale ya
se corrigieron (`upload.ts`, `app.ts`, y el punto 11 en
`admin-frontend/CLAUDE.md`) — si en el futuro se agrega upload de foto de
recibo de verdad, reutiliza `uploadImageToCloudinary()`
(`utils/cloudinary.ts`) con un `folder` distinto (ej. `"receipts"`), no
resucites el patrón de disco local.

**Las 4 fotos de producto que ya existían en disco de ANTES de esta
migración se dejaron tal cual, no se re-subieron a Cloudinary** — sus
`Product.imageUrl` en Mongo siguen apuntando a `${BACKEND_PUBLIC_URL}/
uploads/products/<uuid>.webp`, y por eso **`express.static("/uploads",
...)` en `app.ts` no se quitó** (verificado con una consulta directa a
Mongo antes de decidir esto: 4 productos con `imageUrl` de disco local
al momento de la migración). Si en algún momento se quiere una migración
completa (subir esas 4 a Cloudinary y actualizar sus `imageUrl` en Mongo),
es trabajo aparte — no se hizo acá porque el pedido era "empezar a usar
Cloudinary para las fotos de Inventario" (subidas nuevas), no migrar
datos existentes. Una vez que ya no queden productos con `imageUrl` de
disco local, ese `express.static` y la carpeta `uploads/` dejan de tener
uso y se pueden quitar.

**Variables de entorno nuevas**: `CLOUDINARY_CLOUD_NAME`,
`CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (los tres salen del
dashboard de Cloudinary, pestaña "API Keys") — agregadas a `backend/.env`
y al bloque `environment` del servicio `backend` en `docker-compose.yml`,
mismo patrón que las `SMTP_*` del punto 40 (sin default real, para que
subir una foto sin configurar responda un error claro en vez de fallar
silenciosamente). `cloudinary.config()` no valida credenciales al
llamarse — es solo guardar strings en memoria — así que el servidor
arranca igual aunque estén vacías; el error real (`502 "No se pudo subir
la imagen. Intenta de nuevo."`) recién aparece en el primer intento real
de subir una foto, verificado en vivo antes de completar esta migración.

### 58. `GET /health` — probe liviano sin tocar Mongo, para mantener el backend despierto en Render y evitar cold starts

Complementa al punto 43 de `admin-frontend/CLAUDE.md` (que ya documentaba
el cold start de Render como la causa real de "el login se siente
lento") con la otra mitad de la estrategia: en vez de solo minimizar
cuánto duele un cold start cuando ocurre (una sola llamada de auth en vez
de 4), este punto es sobre evitar que el cold start ocurra para empezar.

- **`app.get("/health", ...)`** (`app.ts`, montado ANTES de
  `/api/pos`/`/api/admin` y de cualquier middleware de auth) responde
  `{ status: "ok", service: "mecatos-backend" }` de forma síncrona — sin
  ninguna consulta a Mongo. A propósito: el objetivo de este endpoint es
  probar únicamente "¿el proceso de Express está vivo y respondiendo?",
  no "¿la base de datos también está sana?" — lo segundo sería un chequeo
  distinto (y más caro/más lento de ejecutar en cada ping), que nadie pidió
  todavía. Si en el futuro se necesita un health check más profundo
  (verificar conexión a Mongo/Redis), que sea un endpoint aparte
  (`/health/deep` o similar) — no le agregues una consulta a este, perdería
  el propósito de ser la opción liviana y rápida para un ping externo
  frecuente.
- **No pasa por CORS ni por ningún middleware de auth** — no hace falta:
  CORS es un mecanismo del navegador (bloquea peticiones cross-origin
  hechas DESDE una página web), y un servicio de monitoreo externo
  (UptimeRobot, Better Uptime, un cron de curl, etc.) no es un navegador —
  le pega directo al endpoint por HTTP, sin `Origin` que `cors()` necesite
  validar. No se agregó `CORS_ORIGIN` ni ninguna excepción para esto,
  simplemente no aplica.
- **El problema real que esto mitiga**: en el plan gratuito/starter de
  Render (ver puntos 40/41 sobre otras limitaciones ya encontradas en
  producción con este mismo proveedor), una instancia sin tráfico entra en
  suspensión tras un período de inactividad, y la SIGUIENTE petición real
  (ej. el primer `GET /api/admin/auth/me` de un admin abriendo la app) paga
  el costo completo de "despertar" el contenedor antes de poder responder
  — decenas de segundos, no milisegundos. El punto 43 ya redujo cuánto se
  siente ese costo (1 llamada de auth en cascada en vez de 4 en paralelo/
  serie), pero la forma de que la mayoría de los usuarios reales NUNCA
  sienta un cold start es que la instancia jamás llegue a dormirse.
- **Estrategia recomendada (configuración externa, no algo que viva en
  este repo)**: apuntar un servicio de monitoreo externo (ej. UptimeRobot,
  cuyo plan gratuito soporta un intervalo mínimo de 5 minutos) a `GET
  https://<dominio-del-backend>/health` con ese intervalo — por debajo del
  umbral de inactividad que usa Render para suspender una instancia, así
  el servicio nunca la ve pasar el tiempo suficiente sin tráfico como para
  dormirse. Esto es configuración del panel de UptimeRobot/del proveedor
  de hosting, no código de este repo — no hay ningún archivo de este
  proyecto que lo automatice ni lo garantice; si se cambia de proveedor de
  monitoreo o de hosting, hay que volver a configurar el ping ahí, no acá.
- **Esto es una mitigación, no una garantía absoluta**: un redeploy, un
  reinicio manual, o un lapso en el que el servicio de monitoreo mismo
  esté caído, igual puede resultar en un cold start ocasional — el punto
  43 sigue siendo la defensa real para ESE caso (que la espera, cuando
  pasa, sea lo más corta posible), este punto solo reduce cuán seguido
  pasa.

### 59. Correo de bienvenida al crear un ADMIN/MANAGER — reutiliza el mecanismo de "olvidé mi contraseña", nunca manda la contraseña en texto plano

Pedido original: que crear un usuario ADMIN/MANAGER desde Personal
dispare un correo de bienvenida con sus credenciales, reutilizando el
proveedor de correo ya configurado (Resend, ver punto 40). **Se desvió a
propósito de un detalle del pedido original** — antes de implementar se le
preguntó explícitamente al usuario si el correo debía mostrar la
contraseña en texto plano que el admin asignó al crear la cuenta, o si
debía reusar el link seguro de "olvidé mi contraseña" en su lugar; se
confirmó la segunda opción. Mandar contraseñas por correo es un
anti-patrón de seguridad conocido (queda guardada indefinidamente en una
bandeja de entrada, pasa por la infraestructura de un tercero, sin
ninguna garantía de que ese canal sea seguro extremo a extremo) — y este
proyecto ya tenía el mecanismo correcto construido y probado en
producción (el flujo de recuperación de contraseña), así que "reutilizar
el servicio de correo existente" se interpretó como reutilizar TODO el
mecanismo (token + link), no solo la librería de envío.

- **`backend/src/utils/passwordResetToken.ts`** (archivo nuevo) —
  `generateResetToken()` extrae la generación de token que antes vivía
  inline solo dentro de `forgotPassword` (`authController.ts`):
  `crypto.randomBytes(32)` crudo, se persiste solo su hash SHA-256, con 1
  hora de vencimiento (`RESET_TOKEN_TTL_MS`, ahora exportado desde acá en
  vez de ser una constante local de `authController.ts`). Se extrajo a un
  util compartido porque **dos flujos distintos generan este mismo tipo
  de token y ambos son consumidos por el mismo endpoint**
  (`POST /auth/reset-password`) — conviene que no puedan desincronizarse
  en formato o duración. `forgotPassword` se migró a usar este helper
  (mismo comportamiento exacto, sin cambios funcionales, ver el diff
  mínimo en `authController.ts`); `resetPassword` no se tocó — ya era
  agnóstico de quién generó el token.
- **`createUser`** (`adminController.ts`), justo después de
  `User.create(doc)`: si `role` es `ADMIN` o `MANAGER` **y** el usuario
  tiene `email` (un cajero nunca lo tiene), genera un token con
  `generateResetToken()`, lo guarda en el mismo documento recién creado
  (`user.resetPasswordTokenHash`/`user.resetPasswordExpires` +
  `user.save()`) y dispara `sendWelcomeEmail(...)` con el link armado
  (`${FRONTEND_URL}/reset-password?token=<crudo>`) — el mismo endpoint
  `POST /auth/reset-password` que ya usa "olvidé mi contraseña" resuelve
  este link sin ningún cambio de backend adicional, porque no le importa
  si el token se originó ahí o en `createUser`.
  - **Fire-and-forget, igual que la sincronización con Google Sheets**
    (punto 21) — a diferencia de `forgotPassword` (que si SÍ espera el
    envío y responde 500 si falla, porque ahí el usuario hizo clic
    esperando un correo), acá un fallo de envío no debe tumbar la
    creación del usuario, que ya se guardó con éxito en Mongo. Errores se
    loguean con `console.error`, nunca se propagan a la respuesta HTTP —
    el pedido original lo exigía explícitamente ("Async Delivery...
    ensure email dispatch delays do not block the HTTP API response").
  - **Bug real evitado, no solo corregido — fuga de
    `resetPasswordTokenHash`/`resetPasswordExpires` en la respuesta**:
    ambos campos tienen `select: false` en el modelo, pero eso solo
    afecta a QUERIES nuevas contra Mongo — como el bloque de arriba los
    asigna directo sobre el documento `user` ya en memoria (antes de que
    su propio `.save()` async termine), `user.toObject()` sí los incluye.
    `createUser` ya borraba `password`/`pin` de `safeUser` antes de
    responder (patrón preexistente); se agregó el mismo `delete` para
    estos dos campos nuevos — sin eso, la respuesta de creación (JSON al
    frontend) habría filtrado el HASH del token (no el token crudo en sí,
    pero sigue siendo un detalle de implementación que no debería salir
    en una respuesta de API).
- **`sendWelcomeEmail(to, name, role, setupUrl)`** (nueva, junto a
  `sendPasswordResetEmail` en `utils/mailerResend.ts`, mismo archivo, no
  uno aparte) — mismo estilo visual que el correo de recuperación (logo
  centrado vía `LOGO_URL`, franja de marca `#ea580c`, botón CTA con el
  mismo degradé): saludo personalizado, anuncio del rol
  ("Administrador"/"Gerente de sede" — mismas etiquetas que
  `roleLabels` en `Sidebar.tsx`, duplicadas acá por ser paquetes
  separados), una caja con el correo de acceso (sin contraseña) y un
  botón **"Configurar mi contraseña"** que lleva al link seguro — el
  pedido original especificaba un botón "Acceder al Sistema" apuntando
  directo a `/login`, pero eso ya no tiene sentido con el diseño elegido:
  el usuario nuevo todavía no tiene una contraseña que él mismo conozca
  hasta usar el link, así que el CTA describe la acción real que hace.
- **Limitación conocida, no resuelta acá — cuenta de Resend en modo de
  prueba** (ver punto 40): sin un dominio propio verificado, Resend solo
  entrega correos a la dirección con la que se creó la cuenta de Resend —
  a cualquier otro destinatario (cualquier ADMIN/MANAGER real que no sea
  esa cuenta) el envío falla con un error real (no silencioso,
  `sendWelcomeEmail` lo relanza igual que `sendPasswordResetEmail`), que
  el `.catch()` de `createUser` atrapa y solo loguea. Verificado en vivo:
  `POST /api/admin/users` con un correo de prueba devolvió `201` con el
  usuario creado correctamente y sin campos sensibles filtrados, y
  `resetPasswordTokenHash`/`resetPasswordExpires` quedaron persistidos en
  Mongo (confirmado con una consulta directa) — el envío del correo en sí
  no se pudo confirmar en este entorno por la restricción de Resend, pero
  toda la lógica previa al envío (creación de usuario, generación y
  persistencia del token, no-bloqueo de la respuesta) funciona. Hasta que
  se verifique un dominio propio en el dashboard de Resend, este correo de
  bienvenida solo llegará de verdad a la bandeja de la cuenta que creó el
  API key de Resend — el resto de administradores/gerentes nuevos no
  recibirán nada (la creación del usuario funciona igual, solo el correo
  no llega).
- **Frontend — `UserModal.tsx` (`admin-frontend`) ya no pide contraseña al
  CREAR un ADMIN/MANAGER, pedido explícito de cierre de este mismo punto**:
  el campo "Contraseña" solo se muestra cuando `isEditing` es verdadero —
  al crear, en su lugar hay una nota informativa ("Le enviaremos un correo
  a esta dirección para que configure su propia contraseña de acceso")
  justo donde antes vivía el input. La validación de `submit()` se
  simplificó a juego: ya no exige `form.password` en ningún caso (ni al
  crear ni al editar) — solo el correo sigue siendo obligatorio para
  ADMIN/MANAGER, mismo mensaje de error sin importar `isEditing`. **Editar
  un ADMIN/MANAGER existente no cambió en nada** — el campo sigue ahí,
  opcional, con el mismo placeholder "Dejar en blanco para no cambiarla" y
  el mismo comportamiento de backend (`updateUser` solo hashea/actualiza
  la contraseña si `password` viene en el body, ver `if (password)
  doc.password = ...`). El toast de éxito al crear un ADMIN/MANAGER (no un
  CASHIER) ahora menciona el correo de bienvenida, para que quede claro
  qué pasó sin tener que adivinarlo. Verificado en vivo con Playwright:
  0 inputs de tipo `password` en el modal de creación tanto para
  `MANAGER` como para `ADMIN`, exactamente 1 en el modal de edición de un
  gerente existente.

### 52. Onboarding interactivo por rol — `User.hasCompletedOnboarding` + dos endpoints (uno por cada modelo de auth, ver punto 6)

`User.ts` ganó un campo nuevo, `hasCompletedOnboarding: boolean` (default
`false`) — compartido por los tres roles (ADMIN/MANAGER/CASHIER usan el
mismo modelo `User`, ver punto 18), aunque el tour que el frontend muestra
según ese flag difiere por rol (ver `admin-frontend/CLAUDE.md` y
`admin-frontend/src/cajero/CLAUDE.md`).

**No existe un único endpoint genérico `/api/users/onboarding-complete`**
— el modelo de auth dual de este proyecto (JWT de admin vs. sesión PIN de
cajero, ver punto 6 del CLAUDE.md raíz) usa cookies, middlewares y rutas
completamente separadas (`/api/admin/*` con `requireAdminAuth` vs.
`/api/pos/*` con `requirePosSession`), así que un endpoint neutral no
podría autenticar ninguno de los dos casos sin mezclar los middlewares —
algo que el CLAUDE.md raíz prohíbe explícitamente (punto 6: "No uses
`requireAdminAuth` en rutas de POS ni viceversa"). En su lugar, dos
endpoints paralelos en `authController.ts`, cada uno resolviendo el id de
usuario desde su propio payload de sesión (`req.admin!.userId` /
`req.posSession!.cashierId`), nunca del body:

- `PATCH /api/admin/auth/onboarding-complete` (`completeAdminOnboarding`,
  registrado en `adminRoutes.ts` después de `router.use(requireAdminAuth)`,
  junto a `/auth/me`).
- `PATCH /api/pos/auth/onboarding-complete` (`completePosOnboarding`,
  `posRoutes.ts`, con `requirePosSession` explícito en la ruta — a
  diferencia de `adminRoutes.ts`, `posRoutes.ts` no tiene un
  `router.use(requirePosSession)` global, cada ruta lo declara aparte).

Ambos hacen lo mismo (`User.findByIdAndUpdate(id, { hasCompletedOnboarding:
true })`) y se llaman tanto al terminar el tour completo como al saltarlo
("Omitir") — el frontend no distingue ambos casos al llamar al backend,
ver el detalle de por qué en `admin-frontend/CLAUDE.md`.

**`adminLogin`/`adminMe` y `posLogin`/`posMe` ahora incluyen
`hasCompletedOnboarding` en su respuesta** — necesario para que el
frontend sepa si debe disparar el tour sin una llamada aparte:
- `adminMe` lo agrega a su `.select(...)` (el campo no tiene
  `select: false`, así que ya venía por defecto, pero se lista explícito
  igual que el resto de campos que sí se seleccionan a mano ahí).
- `posMe` es un caso distinto: `PosSessionPayload` (el JWT del cajero) es
  deliberadamente liviano (`cashierId`/`branchId`/`name`/`loginAt`, ver
  `middlewares/posAuth.ts`) y nunca llevó datos de perfil que puedan
  cambiar después de firmado el token — agregarle `hasCompletedOnboarding`
  ahí lo dejaría desactualizado en cuanto el cajero completara el tour en
  OTRA sesión de PIN sin que este JWT expirara. En vez de eso, `posMe`
  ahora consulta `User.findById(session.cashierId)` en paralelo con el
  lookup de `Branch` que ya hacía, igual que ya se apoya en la sesión para
  `name`/`branchId` pero resuelve `hasCompletedOnboarding` fresco en cada
  llamada.
- `posLogin` sí lo agrega directo desde `matchedUser` (el documento que ya
  trae de la consulta de PIN), sin una consulta aparte.
