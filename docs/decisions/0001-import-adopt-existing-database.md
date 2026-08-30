# ADR 0001 — Adoptar una base de datos existente (`deltix import`)

- **Estado:** Aceptado (MVP cliente implementado)
- **Fecha:** 2026-08-29
- **Alcance:** Deltix-Client (fase servidor se trata aparte, ver *Futuro*)
- **Decisores:** SammyBytes

## Contexto

Hoy, la única manera de que una tabla exista en el Dolt **local** de un proyecto es
que la aplicación (o un cliente MySQL) escriba en `127.0.0.1:3306` después de
`deltix start`. No existe ninguna vía para **adoptar una base de datos que ya está
en uso**, con datos y esquema reales, y convertirla en el punto de partida
versionado de un repositorio Deltix.

El usuario objetivo ya trabaja contra una base con datos y un historial de
migraciones. Quiere: tomar el estado actual, convertirlo en el commit inicial de un
repo Deltix, y seguir trabajando repointando únicamente el *connection string* al
motor local — conservando la facilidad de Git (ramas, checkout, aislamiento,
rollback).

## Decisiones

1. **Es una funcionalidad del cliente (`deltix import`), no un add-on.** Los add-ons
   de Deltix corren *server-side*, sólo al arranque, y hoy su única capacidad
   cableada es `http:route` (`db:read`/`db:write` existen en el SDK pero el host no
   las implementa). Adoptar una base en la máquina del desarrollador es
   inherentemente una operación del cliente (su carpeta, su Dolt en `~/.deltix`).
   *(La fase servidor sí podría materializarse como endpoint core o add-on; ver
   Futuro.)*

2. **Snapshot único** (one-time). No espejo continuo ni replay del historial de
   migraciones. El estado actual de la fuente se convierte en el commit inicial.

3. **Lectura consistente en una sola transacción** de la fuente
   (`REPEATABLE READ` + *consistent snapshot*). Fallback documentado a
   `FLUSH TABLES WITH READ LOCK` cuando el motor no ofrezca un corte transaccional.

4. **Fuente enchufable vía una interfaz `SourceAdapter`.**
   - **MVP: sólo MySQL/MariaDB** (`mysql://`, `mariadb://`), porque Dolt es
     compatible con el protocolo/wire de MySQL y el DDL es intercambiable.
   - Futuro: `postgres://` (requiere traducción de tipos) y `csv://<dir>` (carpeta
     con `<tabla>.sql` + `<tabla>.csv`), ambos como nuevos adaptadores sin tocar el
     resto del pipeline.

5. **Reutiliza el contrato de commit ya existente** — por tabla:
   `{ name, schema (DDL), data (CSV) }`. Los datos adoptados fluyen por el mismo
   `push`/`pull` sin cambios ni formatos paralelos.

6. **Driver embebido de Bun** (`bun:mysql` / `Bun.SQL`), sin invocar `mysqldump` ni
   `mysql` externos. Esto preserva la promesa de *"un único binario sin
   dependencias nativas"* y hace que el comportamiento sea idéntico en la laptop del
   desarrollador y en CI (en CI sólo se necesita un **servidor** MySQL de prueba, no
   las herramientas cliente).
   - **Validación obligatoria en Fase 1:** confirmar que el módulo builtin de Bun
     queda incluido al compilar con `bun build --compile`.

7. **BLOB / binario → opción explícita del operador** con `--blobs <modo>`:
   - `error` (**por defecto**): si la fuente tiene columnas binarias, el import se
     detiene y avisa. Nada se corrompe en silencio.
   - `base64`: codifica binarios a base64 en el CSV y los decodifica al cargar
     (usando el DDL para identificar columnas binarias). Round-trip seguro.
   - `skip`: importa tablas/columnas no binarias y omite las binarias con warning.
   - Se documenta que el CSV crudo no transporta binario de forma segura; `base64`
     es la vía soportada.

## Experiencia de desarrollador (DX)

```
deltix import <repo> --from <dsn> [--table t ...] [--schema-only]
                    [--no-commit] [--blobs error|base64|skip]
```

- **Cero fricción:** si no se pasa `--from`, entra en modo interactivo
  (host/puerto/usuario/contraseña/base), igual que `deltix configure`.
- **Secretos fuera del historial:** el DSN también puede venir por la variable de
  entorno `DELTIX_IMPORT_URL`, para no escribir la contraseña en la línea de
  comandos.
- **`import` = `init` + carga + commit inicial** (`"adopt <db> @ <ts>"`), salvo que
  se use `--no-commit` para revisar antes de commitear.
- **Salida accionable**, p. ej.:
  ```
  Importing hmc_orders ← mysql://10.1.10.50:3306/legacy
  ✓ 12 tablas, 48.120 filas leídas (snapshot consistente)
  ✓ cargadas en el Dolt local (1.4s)
  ✓ commit "adopt legacy @ 2026-08-29"
  → sigue con:  deltix push
  → tu app ya puede apuntar a 127.0.0.1:3306
  ```
- Pensado para tres perfiles: **desarrollador** (adopta y sigue), **DevOps**
  (desatendido con `--from`/`DELTIX_IMPORT_URL` en un pipeline), **sysadmin** (una
  sola máquina, sin infra extra).

## Integridad y rendimiento

- **Bulk load con `dolt table import -c`** en lugar del bucle de un `INSERT` por
  subproceso que usan hoy `applyCommits`/`dolt-commit-import-cli` (O(filas) spawns →
  acantilado de rendimiento en tablas grandes). El import adopta la vía rápida.
- **Orden topológico por claves foráneas** al crear tablas, para no violar
  restricciones durante la carga.
- **Corte consistente** garantizado por la transacción de lectura de la fuente.
- **Esquema como DDL** (no inferido del CSV): preserva tipos y **clave primaria**.
  Una tabla importada sin PK se permite pero se avisa (Dolt no la versiona bien).

## Seguridad (OWASP Top 10 / ASVS)

- Conexión al origen **read-only**; se recomienda un usuario de sólo lectura.
- **Redacción** de la contraseña del DSN en logs y mensajes de error.
- Todo `dolt`/driver se ejecuta vía **argv arrays** (nunca una cadena de shell),
  evitando inyección (A03).
- Nombres de tabla/esquema validados contra el allow-list de identificadores antes
  de interpolarse en SQL.
- Sin secretos hardcodeados; credenciales por argumento, `DELTIX_IMPORT_URL` o
  prompt interactivo.

## Límites / no-metas (por ahora)

- Postgres/SQL Server y `csv://` no entran en el MVP.
- Vistas, triggers y procedimientos almacenados **no** se adoptan (sólo tablas
  base). Documentado como límite.
- Tablas sin PK: se importan con warning.
- El replay del historial de migraciones como múltiples commits queda fuera.

## Fases

1. **MVP (cliente):** `deltix import` + interfaz `SourceAdapter` + adaptador
   **MySQL/MariaDB** + bulk load (`dolt table import`) + snapshot consistente +
   `--blobs` + commit inicial + push. Con pruebas y DX.
2. **Más motores:** `postgres://` y `csv://` como nuevos `SourceAdapter`.
3. **Servidor (fase aparte, NO en este ADR):** ingesta server-side para poblar un
   repo desde una fuente, de modo que los demás clientes sólo hagan
   `deltix clone`/`pull`. Podría ser un endpoint core o un add-on una vez que el
   host implemente `db:write`. Reutiliza el mismo `{name, schema, data}`.
4. **Plugins de cliente** para que la comunidad publique adaptadores (subsistema
   nuevo, se evalúa aparte).

## Pruebas

- **Unit:** parser de DSN, redacción de secretos, orden topológico por FK,
  detección de columnas binarias, mapeo a `{name, schema, data}`.
- **Integración (Dolt real + servidor MySQL):** import → commit → push → pull en
  otro checkout → verificar datos **y clave primaria**.
- **Casos borde:** tabla vacía, sin PK, NULLs, UTF-8/comillas embebidas, y los tres
  modos de `--blobs`.

## Referencias

- Contrato de commit y push/pull: `src/contexts/versioning-local/` (cliente) y
  `src/contexts/versioning/commit-import.service.ts` / `commit-export.service.ts`
  (servidor).
- Modelo de add-ons (por qué no aplica a la fase cliente): `Deltix-Server`
  `packages/addon-sdk` y ADR del servidor `0001`.
