# Mega Rifas Security Specification (Phase 0 TDD)

## 1. Data Invariants

1. **Public Board vs Private PII Split (Pillar 6):**
   - `/tickets/{ticketId}` contains ZERO raw PII (no cédula, no email, no phone). It stores only `numero`, `estatus`, masked `displayName`, `cedulaHash` (SHA-256 hex), and timestamps.
   - `/ticketContacts/{ticketId}` and `/paymentReports/{reportId}` store raw PII (`cedula`, `nombre`, `telefono`, `correo`) and are strictly readable ONLY by verified admins (`isAdmin()`).
2. **Admin Identity Hardening:**
   - Admin checks strictly require `request.auth != null && request.auth.token.email_verified == true` and either the bootstrapped admin email (`ricocesar86@gmail.com`) or an explicit `/admins/{uid}` document.
   - Non-admins can never create or promote themselves in `/admins/{uid}`.
3. **Ticket State Machine & Terminal Locking:**
   - Public buyers can only transition a ticket from non-existent/`DISPONIBLE` to `RESERVADO` or `ESPERA`, or from `RESERVADO` to `ESPERA` **only if `incoming().cedulaHash == existing().cedulaHash`**.
   - Public buyers can NEVER set `estatus == 'PAGADO'`, NEVER modify a `PAGADO` or `ESPERA` ticket, NEVER release (`DISPONIBLE`), and NEVER delete tickets.
4. **Atomicity Guarantee (Pillar 7):**
   - Every non-admin ticket write requires `existsAfter(/databases/$(database)/documents/ticketContacts/$(ticketId))` and every non-admin `ticketContacts` write requires matching `getAfter(/databases/$(database)/documents/tickets/$(ticketId))`.
5. **Strict Schema & Server Timestamps:**
   - Every collection validates required + allowed keys (`hasAll` + `hasOnly`), exact field types, bounded string/array lengths, and `request.time` on `createdAt`/`updatedAt`/`resolvedAt`.

## 2. The "Dirty Dozen" Adversarial Payloads

| # | Attack Vector | Target Path | Malicious Payload / Action | Expected Result |
|---|---|---|---|---|
| 1 | **Unauthorized Config Write** | `/raffleConfig/main` | Unauthenticated user attempts `update` on `precioTicketUSD: 0.01` | `PERMISSION_DENIED` |
| 2 | **Email Spoofing Admin Bypass** | `/raffleConfig/main` | Auth token has `email: "ricocesar86@gmail.com"`, `email_verified: false` | `PERMISSION_DENIED` |
| 3 | **Self-Assigned Admin Role** | `/admins/attackerUid` | Authenticated non-admin creates `{ email: "a@b.com", role: "admin", createdAt: serverTimestamp() }` | `PERMISSION_DENIED` |
| 4 | **Ticket Status Shortcutting (Self-Pay)** | `/tickets/05` | Public buyer creates `{ numero: "05", estatus: "PAGADO", ... }` | `PERMISSION_DENIED` |
| 5 | **Reserved Ticket Hijacking** | `/tickets/05` | Attacker with different `cedulaHash` updates existing `RESERVADO` ticket to `ESPERA` | `PERMISSION_DENIED` |
| 6 | **Terminal State Tampering** | `/tickets/05` | Non-admin attempts update on existing `PAGADO` ticket | `PERMISSION_DENIED` |
| 7 | **Shadow / Ghost Field Injection** | `/tickets/07` | Buyer creates ticket with extra field `{ isWinner: true }` | `PERMISSION_DENIED` |
| 8 | **Orphaned Ticket Write (No Contact Batch)** | `/tickets/08` | Buyer writes `/tickets/08` without atomic `/ticketContacts/08` | `PERMISSION_DENIED` |
| 9 | **PII Exfiltration (Ticket Contacts)** | `/ticketContacts/05` | Unauthenticated or non-admin user calls `get` or `list` | `PERMISSION_DENIED` |
| 10 | **PII Exfiltration (Payment Reports)** | `/paymentReports` | Non-admin user calls `get` or `list` on payment reports | `PERMISSION_DENIED` |
| 11 | **Pre-Approved Payment Report** | `/paymentReports/rep1` | Buyer creates payment report with `estatus: "APROBADO"` | `PERMISSION_DENIED` |
| 12 | **ID Poisoning & Payload Exhaustion** | `/paymentReports/bad..id` | Oversized ID (>128 chars) or `numeros` array of 100 items or `comprobante` > 350KB | `PERMISSION_DENIED` |
