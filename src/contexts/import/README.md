# Context: import

Adopta una base de datos **existente** (con datos y esquema reales) y la
convierte en el commit inicial de un repositorio Deltix local. Es una operación
del **cliente** (ver `docs/decisions/0001-import-adopt-existing-database.md`).

## Qué hace

`deltix import <repo> --from <dsn>` conecta a una fuente, lee un snapshot
consistente, y carga cada tabla en el Dolt local con su esquema (DDL, que
preserva tipos y clave primaria) y sus filas, haciendo un commit inicial. De ahí
en adelante se usa el `push`/`pull` normal.

## Diseño

- **`SourceAdapter`** (interfaz): `connect` (snapshot consistente), `listTables`,
  `foreignKeyEdges`, `readTable`, `close`. MVP: **`mysql-adapter`** (MySQL y
  MariaDB vía `mysql2`, driver JS puro que empaqueta en el binario compilado).
- **`csv.ts`**: serializa filas a CSV RFC-4180 para `dolt table import`. NULL →
  campo vacío; binarios según `--blobs`.
- **`table-order.ts`**: orden topológico por claves foráneas (padres antes que
  hijos).
- **`import.service.ts`**: orquesta leer → aplicar política de binarios →
  `VersioningLocalService.bulkImportTables` (create DDL + `dolt table import -r`
  + `FROM_BASE64` si aplica) → `commit` inicial.
- **`dsn.ts`**: parsea y **redacta** la contraseña (nunca se loguea).

## Seguridad / integridad

- Conexión **read-only** al origen; transacción `REPEATABLE READ` con
  `CONSISTENT SNAPSHOT`.
- Nada se escribe en el repo local hasta leer y validar **todas** las tablas
  (un `--blobs error` aborta sin tocar nada).
- Identificadores validados; `dolt` vía argv arrays (sin shell).
- `dateStrings` evita desfases de zona horaria en DATE/DATETIME.

## Política de binarios (`--blobs`)

- `error` (default): aborta si hay columnas BLOB/binarias y las lista.
- `base64`: codifica en el CSV y decodifica con `FROM_BASE64` tras la carga.
- `skip`: omite tablas con columnas binarias (avisa cuáles).

## Límites

- Sólo tablas base (no vistas/triggers/proc).
- Postgres y `csv://` quedan para fases futuras (nuevos `SourceAdapter`).
