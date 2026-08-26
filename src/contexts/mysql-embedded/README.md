# Context: mysql-embedded

Status: placeholder — implementation scheduled for Fase 2 of the roadmap:
`deltix start` manages the local `dolt sql-server` process on
`127.0.0.1:3306`. Zero dependency on a pre-installed MySQL service on the host.

Only `index.ts` from this folder may be imported by other contexts (ACL boundary).
