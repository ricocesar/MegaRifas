import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
  writeBatch,
  serverTimestamp,
  Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { ADMIN_BOOTSTRAP_EMAIL, db, handleFirestoreError, OperationType } from './firebase';

export type TicketStatus = 'DISPONIBLE' | 'RESERVADO' | 'ESPERA' | 'PAGADO';
export type PaymentStatus = 'PENDIENTE' | 'APROBADO' | 'RECHAZADO';
export type PaymentMethodLabel =
  | 'Pago Móvil'
  | 'Transferencia'
  | 'Binance'
  | 'Zelle'
  | 'Efectivo'
  | 'USDT';

export interface RaffleConfigData {
  tituloRifa: string;
  totalNumeros: number;
  precioTicketUSD: number;
  tasa: number;
  tasaManual: number;
  premios: string;
  noticias: string;
  tickerNoticias: string;
  fechaSorteo: string;
  diasLimitePago: number;
  diasBloqueo: number;
  pmDatos: string;
  trDatos: string;
  binanceDatos: string;
  zelleDatos: string;
  efectivoDatos: string;
  usdtDatos: string;
  igUrl: string;
  waList: string[];
  adminEmails: string[];
  emailjsEnabled: boolean;
  emailjsServiceId: string;
  emailjsPublicKey: string;
  emailjsTemplateCompra: string;
  emailjsTemplateAprobacion: string;
  updatedAtMs?: number;
}

export interface TicketDoc {
  numero: string;
  estatus: TicketStatus;
  displayName: string;
  cedulaHash: string;
  reservedAtMs: number | null;
  paidAtMs: number | null;
  updatedAtMs: number;
}

export interface TicketContactDoc {
  numero: string;
  cedula: string;
  cedulaHash: string;
  nombre: string;
  telefono: string;
  correo: string;
  updatedAtMs: number;
}

export interface PaymentReportDoc {
  id: string;
  cedula: string;
  cedulaHash: string;
  nombre: string;
  telefono: string;
  correo: string;
  numeros: string[];
  montoUSD: number;
  montoBs: number;
  metodo: PaymentMethodLabel;
  referencia: string;
  comprobante: string;
  estatus: PaymentStatus;
  createdAtMs: number;
  resolvedAtMs: number | null;
}

export const DEFAULT_RAFFLE_CONFIG: RaffleConfigData = {
  tituloRifa: 'Diciembre',
  totalNumeros: 50,
  precioTicketUSD: 5,
  tasa: 919.82,
  tasaManual: 0,
  premios: '(1) Parlante 8"×²',
  noticias: '¡Bienvenidos! Sorteo en vivo este domingo a las 8:00 PM.',
  tickerNoticias:
    '🎉 Próximo sorteo este domingo 8PM | 🏆 Premios espectaculares | 📲 Síguenos en Instagram',
  fechaSorteo: '',
  diasLimitePago: 15,
  diasBloqueo: 3,
  pmDatos: 'Banco: Bancamiga (0172) • Tel: 04129023035 • C.I: 11849041',
  trDatos: 'Bancamiga Cta Corriente: 0172-0000-00-0000000000',
  binanceDatos: 'Escribe a soporte para coordinar pago por Binance Pay.',
  zelleDatos: 'Escribe a soporte para coordinar pago por Zelle.',
  efectivoDatos: 'Escribe a soporte para coordinar pago en efectivo.',
  usdtDatos: 'Escribe a soporte para coordinar pago por USDT.',
  igUrl: 'https://instagram.com/megarifas',
  waList: ['584129023035'],
  adminEmails: [ADMIN_BOOTSTRAP_EMAIL.toLowerCase()],
  emailjsEnabled: false,
  emailjsServiceId: '',
  emailjsPublicKey: '',
  emailjsTemplateCompra: '',
  emailjsTemplateAprobacion: '',
};

const VALID_METHODS = new Set<PaymentMethodLabel>([
  'Pago Móvil',
  'Transferencia',
  'Binance',
  'Zelle',
  'Efectivo',
  'USDT',
]);

function toMillis(val: unknown): number | null {
  if (!val) return null;
  if (val instanceof Timestamp) return val.toMillis();
  if (typeof val === 'object' && val !== null && 'toMillis' in val) {
    return (val as { toMillis: () => number }).toMillis();
  }
  if (typeof val === 'number' && isFinite(val)) return val;
  return null;
}

function clampStr(v: unknown, maxLen: number): string {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, maxLen);
}

export function normalizeDigits(v: unknown): string {
  return String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
}

export function normalizeAdminEmail(raw: unknown): string {
  return String(raw === undefined || raw === null ? '' : raw)
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

export function isValidAdminEmailFormat(email: string): boolean {
  return email.length >= 5 && email.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizeAdminEmails(rawList: unknown): string[] {
  const primary = ADMIN_BOOTSTRAP_EMAIL.trim().toLowerCase();
  const seen = new Set<string>([primary]);
  const result: string[] = [primary];

  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      const clean = normalizeAdminEmail(item);
      if (!clean || seen.has(clean) || !isValidAdminEmailFormat(clean)) continue;
      seen.add(clean);
      result.push(clean);
      if (result.length >= 20) break;
    }
  }
  return result;
}

export function maskDisplayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Participante';
  const first = parts[0];
  const short = parts[1] ? `${first} ${parts[1].charAt(0).toUpperCase()}.` : first;
  return short.slice(0, 40);
}

export async function sha256Hex(input: string): Promise<string> {
  const normalized = normalizeDigits(input);
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fetchLiveBcvRate(): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch('https://ve.dolarapi.com/v1/dolares/oficial', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { promedio?: number; venta?: number };
    const rate = Number(json.promedio || json.venta || 0);
    return isFinite(rate) && rate > 0 ? Number(rate.toFixed(2)) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function isSixDigitRef(ref: string): boolean {
  return /^[0-9]{6}$/.test(ref);
}

function parseConfigSnapshot(raw: Record<string, unknown> | undefined): RaffleConfigData {
  if (!raw) return { ...DEFAULT_RAFFLE_CONFIG };
  const total = Math.min(1000, Math.max(1, Math.floor(Number(raw.totalNumeros) || DEFAULT_RAFFLE_CONFIG.totalNumeros)));
  const precio = Number(raw.precioTicketUSD);
  const tasaManual = Number(raw.tasaManual);
  const tasa = Number(raw.tasa);
  const diasPago = Number(raw.diasLimitePago);
  const diasBloq = Number(raw.diasBloqueo);
  const waRaw = Array.isArray(raw.waList) ? raw.waList : DEFAULT_RAFFLE_CONFIG.waList;

  return {
    tituloRifa: raw.tituloRifa !== undefined ? clampStr(raw.tituloRifa, 120) : DEFAULT_RAFFLE_CONFIG.tituloRifa,
    totalNumeros: total,
    precioTicketUSD: isFinite(precio) && precio > 0 ? precio : DEFAULT_RAFFLE_CONFIG.precioTicketUSD,
    tasa: isFinite(tasa) && tasa >= 0 ? tasa : DEFAULT_RAFFLE_CONFIG.tasa,
    tasaManual: isFinite(tasaManual) && tasaManual >= 0 ? tasaManual : 0,
    premios: raw.premios !== undefined ? clampStr(raw.premios, 300) : DEFAULT_RAFFLE_CONFIG.premios,
    noticias: raw.noticias !== undefined ? clampStr(raw.noticias, 500) : DEFAULT_RAFFLE_CONFIG.noticias,
    tickerNoticias: raw.tickerNoticias !== undefined ? clampStr(raw.tickerNoticias, 500) : DEFAULT_RAFFLE_CONFIG.tickerNoticias,
    fechaSorteo: raw.fechaSorteo !== undefined ? clampStr(raw.fechaSorteo, 30) : '',
    diasLimitePago: isFinite(diasPago) && diasPago >= 1 ? Math.floor(diasPago) : 15,
    diasBloqueo: isFinite(diasBloq) && diasBloq >= 0 ? Math.floor(diasBloq) : 3,
    pmDatos: raw.pmDatos !== undefined ? clampStr(raw.pmDatos, 300) : DEFAULT_RAFFLE_CONFIG.pmDatos,
    trDatos: raw.trDatos !== undefined ? clampStr(raw.trDatos, 300) : DEFAULT_RAFFLE_CONFIG.trDatos,
    binanceDatos: raw.binanceDatos !== undefined ? clampStr(raw.binanceDatos, 300) : DEFAULT_RAFFLE_CONFIG.binanceDatos,
    zelleDatos: raw.zelleDatos !== undefined ? clampStr(raw.zelleDatos, 300) : DEFAULT_RAFFLE_CONFIG.zelleDatos,
    efectivoDatos: raw.efectivoDatos !== undefined ? clampStr(raw.efectivoDatos, 300) : DEFAULT_RAFFLE_CONFIG.efectivoDatos,
    usdtDatos: raw.usdtDatos !== undefined ? clampStr(raw.usdtDatos, 300) : DEFAULT_RAFFLE_CONFIG.usdtDatos,
    igUrl: raw.igUrl !== undefined ? clampStr(raw.igUrl, 200) : DEFAULT_RAFFLE_CONFIG.igUrl,
    waList: waRaw.map((w) => normalizeDigits(w)).filter(Boolean).slice(0, 3),
    adminEmails: normalizeAdminEmails(raw.adminEmails),
    emailjsEnabled: Boolean(raw.emailjsEnabled),
    emailjsServiceId: clampStr(raw.emailjsServiceId, 100),
    emailjsPublicKey: clampStr(raw.emailjsPublicKey, 100),
    emailjsTemplateCompra: clampStr(raw.emailjsTemplateCompra, 100),
    emailjsTemplateAprobacion: clampStr(raw.emailjsTemplateAprobacion, 100),
    updatedAtMs: toMillis(raw.updatedAt) || undefined,
  };
}

function buildConfigPayload(cfg: RaffleConfigData) {
  return {
    tituloRifa: clampStr(cfg.tituloRifa, 120),
    totalNumeros: Math.min(1000, Math.max(1, Math.floor(Number(cfg.totalNumeros) || 50))),
    precioTicketUSD: Number(cfg.precioTicketUSD),
    tasa: Number(cfg.tasa) >= 0 ? Number(cfg.tasa) : 0,
    tasaManual: Number(cfg.tasaManual) >= 0 ? Number(cfg.tasaManual) : 0,
    premios: clampStr(cfg.premios, 300),
    noticias: clampStr(cfg.noticias, 500),
    tickerNoticias: clampStr(cfg.tickerNoticias, 500),
    fechaSorteo: clampStr(cfg.fechaSorteo, 30),
    diasLimitePago: Math.min(365, Math.max(1, Math.floor(Number(cfg.diasLimitePago) || 15))),
    diasBloqueo: Math.min(365, Math.max(0, Math.floor(Number(cfg.diasBloqueo) || 0))),
    pmDatos: clampStr(cfg.pmDatos, 300),
    trDatos: clampStr(cfg.trDatos, 300),
    binanceDatos: clampStr(cfg.binanceDatos, 300),
    zelleDatos: clampStr(cfg.zelleDatos, 300),
    efectivoDatos: clampStr(cfg.efectivoDatos, 300),
    usdtDatos: clampStr(cfg.usdtDatos, 300),
    igUrl: clampStr(cfg.igUrl, 200),
    waList: (cfg.waList || []).map((w) => normalizeDigits(w).slice(0, 25)).filter(Boolean).slice(0, 3),
    adminEmails: normalizeAdminEmails(cfg.adminEmails),
    emailjsEnabled: Boolean(cfg.emailjsEnabled),
    emailjsServiceId: clampStr(cfg.emailjsServiceId, 100),
    emailjsPublicKey: clampStr(cfg.emailjsPublicKey, 100),
    emailjsTemplateCompra: clampStr(cfg.emailjsTemplateCompra, 100),
    emailjsTemplateAprobacion: clampStr(cfg.emailjsTemplateAprobacion, 100),
    updatedAt: serverTimestamp(),
  };
}

/* ==================== PUBLIC REALTIME SUBSCRIPTIONS ==================== */

export function subscribeRaffleConfig(
  onData: (config: RaffleConfigData, existsInDb: boolean) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = 'raffleConfig/main';
  return onSnapshot(
    doc(db, 'raffleConfig', 'main'),
    (snap) => {
      if (snap.exists()) {
        onData(parseConfigSnapshot(snap.data()), true);
      } else {
        onData({ ...DEFAULT_RAFFLE_CONFIG }, false);
      }
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (wrapped) {
        if (onError) onError(wrapped as Error);
      }
    }
  );
}

const PUBLIC_TICKET_STATUSES: TicketStatus[] = ['DISPONIBLE', 'RESERVADO', 'ESPERA', 'PAGADO'];
const PAYMENT_REPORT_STATUSES: PaymentStatus[] = ['PENDIENTE', 'APROBADO', 'RECHAZADO'];

function publicTicketsQuery() {
  return query(collection(db, 'tickets'), where('estatus', 'in', PUBLIC_TICKET_STATUSES));
}

function adminPaymentReportsQuery() {
  return query(collection(db, 'paymentReports'), where('estatus', 'in', PAYMENT_REPORT_STATUSES));
}

function adminTicketContactsQuery() {
  return query(collection(db, 'ticketContacts'), where('numero', '>=', '0'));
}

function adminPaymentReferencesQuery() {
  return query(collection(db, 'paymentReferences'), where('estatus', 'in', ['PENDIENTE', 'APROBADO']));
}

export function subscribeTickets(
  onData: (tickets: Record<string, TicketDoc>) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = 'tickets';
  return onSnapshot(
    publicTicketsQuery(),
    (snap) => {
      const map: Record<string, TicketDoc> = {};
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        const numero = String(d.numero || docSnap.id);
        map[numero] = {
          numero,
          estatus: (d.estatus as TicketStatus) || 'DISPONIBLE',
          displayName: String(d.displayName || ''),
          cedulaHash: String(d.cedulaHash || ''),
          reservedAtMs: toMillis(d.reservedAt),
          paidAtMs: toMillis(d.paidAt),
          updatedAtMs: toMillis(d.updatedAt) || Date.now(),
        };
      });
      onData(map);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError) onError(wrapped as Error);
      }
    }
  );
}

/* ==================== BUYER OPERATIONS ==================== */

export async function reserveTicketsInFirestore(params: {
  cedula: string;
  nombre: string;
  telefono: string;
  correo: string;
  numeros: string[];
}): Promise<void> {
  const cedula = normalizeDigits(params.cedula).slice(0, 20);
  const nombre = clampStr(params.nombre, 100);
  const telefono = clampStr(params.telefono, 25);
  const correo = clampStr(params.correo, 120);
  if (cedula.length < 4) throw new Error('Ingresa una cédula válida (mínimo 4 dígitos).');
  if (nombre.length < 2) throw new Error('Ingresa tu nombre completo.');
  if (telefono.length < 7) throw new Error('Ingresa un teléfono WhatsApp válido.');
  if (correo.length < 5 || !correo.includes('@')) throw new Error('Ingresa un correo electrónico válido.');
  if (!params.numeros.length || params.numeros.length > 50) {
    throw new Error('Selecciona entre 1 y 50 números.');
  }

  const cedulaHash = await sha256Hex(cedula);
  const displayName = maskDisplayName(nombre);

  // Verify availability on server first to give friendly conflict messages
  const conflicts: string[] = [];
  for (const num of params.numeros) {
    try {
      const existing = await getDoc(doc(db, 'tickets', num));
      if (existing.exists() && existing.data()?.estatus !== 'DISPONIBLE') {
        conflicts.push(num);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `tickets/${num}`);
    }
  }
  if (conflicts.length) {
    throw new Error(`Estos números ya fueron tomados: #${conflicts.join(', #')}`);
  }

  const batch = writeBatch(db);
  for (const num of params.numeros) {
    batch.set(doc(db, 'tickets', num), {
      numero: num,
      estatus: 'RESERVADO',
      displayName,
      cedulaHash,
      reservedAt: serverTimestamp(),
      paidAt: null,
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'ticketContacts', num), {
      numero: num,
      cedula,
      cedulaHash,
      nombre,
      telefono,
      correo,
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'tickets');
  }
}

export async function submitPaymentReportInFirestore(params: {
  cedula: string;
  nombre: string;
  telefono: string;
  correo: string;
  numeros: string[];
  montoUSD: number;
  montoBs: number;
  metodo: PaymentMethodLabel;
  referencia: string;
  currentTickets: Record<string, TicketDoc>;
}): Promise<string> {
  const cedula = normalizeDigits(params.cedula).slice(0, 20);
  const nombre = clampStr(params.nombre, 100);
  const telefono = clampStr(params.telefono, 25);
  const correo = clampStr(params.correo, 120);
  const referencia = clampStr(params.referencia, 30);
  const requiresBankRef = params.metodo === 'Pago Móvil' || params.metodo === 'Transferencia';

  if (cedula.length < 4) throw new Error('Ingresa una cédula válida.');
  if (nombre.length < 2) throw new Error('Ingresa tu nombre completo.');
  if (telefono.length < 7) throw new Error('Ingresa un teléfono WhatsApp válido.');
  if (correo.length < 5 || !correo.includes('@')) throw new Error('Ingresa un correo válido.');
  if (!params.numeros.length || params.numeros.length > 50) {
    throw new Error('Selecciona entre 1 y 50 números.');
  }
  if (!VALID_METHODS.has(params.metodo)) throw new Error('Método de pago inválido.');
  if (!referencia) throw new Error('Ingresa la referencia de pago.');
  if (requiresBankRef && !isSixDigitRef(referencia)) {
    throw new Error('La referencia bancaria debe tener exactamente 6 dígitos numéricos.');
  }

  // 1) Validate unique 6-digit bank reference against active payments in Firestore
  if (requiresBankRef) {
    try {
      const refSnap = await getDoc(doc(db, 'paymentReferences', referencia));
      if (refSnap.exists()) {
        throw new Error(
          'Esta referencia ya fue registrada anteriormente. Verifica los últimos 6 dígitos.'
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Esta referencia ya fue registrada')) {
        throw error;
      }
      handleFirestoreError(error, OperationType.GET, `paymentReferences/${referencia}`);
    }
  }

  const cedulaHash = await sha256Hex(cedula);
  const displayName = maskDisplayName(nombre);

  // 2) Check each selected ticket on server
  const conflicts: string[] = [];
  const existingSnaps = new Map<string, Record<string, unknown> | null>();
  for (const num of params.numeros) {
    try {
      const snap = await getDoc(doc(db, 'tickets', num));
      if (!snap.exists()) {
        existingSnaps.set(num, null);
      } else {
        const d = snap.data();
        const est = String(d.estatus || 'DISPONIBLE');
        if (est === 'DISPONIBLE' || (est === 'RESERVADO' && d.cedulaHash === cedulaHash)) {
          existingSnaps.set(num, d);
        } else {
          conflicts.push(num);
        }
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `tickets/${num}`);
    }
  }
  if (conflicts.length) {
    throw new Error(
      `Estos números ya no están disponibles o pertenecen a otra cédula: #${conflicts.join(', #')}`
    );
  }

  const reportId = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const batch = writeBatch(db);

  for (const num of params.numeros) {
    const prev = existingSnaps.get(num);
    if (prev && prev.estatus === 'RESERVADO') {
      batch.update(doc(db, 'tickets', num), {
        estatus: 'ESPERA',
        displayName,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(doc(db, 'tickets', num), {
        numero: num,
        estatus: 'ESPERA',
        displayName,
        cedulaHash,
        reservedAt: null,
        paidAt: null,
        updatedAt: serverTimestamp(),
      });
    }

    batch.set(doc(db, 'ticketContacts', num), {
      numero: num,
      cedula,
      cedulaHash,
      nombre,
      telefono,
      correo,
      updatedAt: serverTimestamp(),
    });
  }

  batch.set(doc(db, 'paymentReports', reportId), {
    cedula,
    cedulaHash,
    nombre,
    telefono,
    correo,
    numeros: params.numeros.slice(),
    montoUSD: Number(params.montoUSD.toFixed(2)),
    montoBs: Number(params.montoBs.toFixed(2)),
    metodo: params.metodo,
    referencia,
    comprobante: '',
    estatus: 'PENDIENTE',
    createdAt: serverTimestamp(),
    resolvedAt: null,
  });

  if (requiresBankRef) {
    batch.set(doc(db, 'paymentReferences', referencia), {
      referencia,
      reportId,
      estatus: 'PENDIENTE',
      createdAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    // Handle race condition where another user registered the exact same 6 digits simultaneously
    if (requiresBankRef) {
      try {
        const refCheck = await getDoc(doc(db, 'paymentReferences', referencia));
        if (refCheck.exists()) {
          throw new Error(
            'Esta referencia ya fue registrada anteriormente. Verifica los últimos 6 dígitos.'
          );
        }
      } catch (dupErr) {
        if (dupErr instanceof Error && dupErr.message.includes('Esta referencia ya fue registrada')) {
          throw dupErr;
        }
      }
    }
    handleFirestoreError(error, OperationType.WRITE, `paymentReports/${reportId}`);
  }
  return reportId;
}

/* ==================== ADMIN OPERATIONS ==================== */

export async function ensureConfigSeeded(currentConfig: RaffleConfigData): Promise<void> {
  const path = 'raffleConfig/main';
  try {
    const snap = await getDoc(doc(db, 'raffleConfig', 'main'));
    if (!snap.exists()) {
      await setDoc(doc(db, 'raffleConfig', 'main'), buildConfigPayload(currentConfig));
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function saveRaffleConfigInFirestore(
  config: RaffleConfigData
): Promise<RaffleConfigData> {
  const path = 'raffleConfig/main';
  const payload = buildConfigPayload(config);
  try {
    await setDoc(doc(db, 'raffleConfig', 'main'), payload);
    const verifiedSnap = await getDocFromServer(doc(db, 'raffleConfig', 'main'));
    if (!verifiedSnap.exists()) {
      throw new Error('No se pudo verificar el documento guardado en Firestore.');
    }
    return parseConfigSnapshot(verifiedSnap.data());
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function fetchAdminAllData(): Promise<{
  payments: PaymentReportDoc[];
  contacts: Record<string, TicketContactDoc>;
  tickets: Record<string, TicketDoc>;
}> {
  const [paySnap, contactSnap, ticketSnap] = await Promise.all([
    getDocs(adminPaymentReportsQuery()).catch((e) =>
      handleFirestoreError(e, OperationType.LIST, 'paymentReports')
    ),
    getDocs(adminTicketContactsQuery()).catch((e) =>
      handleFirestoreError(e, OperationType.LIST, 'ticketContacts')
    ),
    getDocs(publicTicketsQuery()).catch((e) =>
      handleFirestoreError(e, OperationType.LIST, 'tickets')
    ),
  ]);

  const payments: PaymentReportDoc[] = [];
  paySnap.forEach((docSnap) => {
    const d = docSnap.data();
    payments.push({
      id: docSnap.id,
      cedula: String(d.cedula || ''),
      cedulaHash: String(d.cedulaHash || ''),
      nombre: String(d.nombre || ''),
      telefono: String(d.telefono || ''),
      correo: String(d.correo || ''),
      numeros: Array.isArray(d.numeros) ? d.numeros.map(String) : [],
      montoUSD: Number(d.montoUSD) || 0,
      montoBs: Number(d.montoBs) || 0,
      metodo: (d.metodo as PaymentMethodLabel) || 'Pago Móvil',
      referencia: String(d.referencia || ''),
      comprobante: String(d.comprobante || ''),
      estatus: (d.estatus as PaymentStatus) || 'PENDIENTE',
      createdAtMs: toMillis(d.createdAt) || Date.now(),
      resolvedAtMs: toMillis(d.resolvedAt),
    });
  });
  payments.sort((a, b) => b.createdAtMs - a.createdAtMs);

  const contacts: Record<string, TicketContactDoc> = {};
  contactSnap.forEach((docSnap) => {
    const d = docSnap.data();
    const numero = String(d.numero || docSnap.id);
    contacts[numero] = {
      numero,
      cedula: String(d.cedula || ''),
      cedulaHash: String(d.cedulaHash || ''),
      nombre: String(d.nombre || ''),
      telefono: String(d.telefono || ''),
      correo: String(d.correo || ''),
      updatedAtMs: toMillis(d.updatedAt) || Date.now(),
    };
  });

  const tickets: Record<string, TicketDoc> = {};
  ticketSnap.forEach((docSnap) => {
    const d = docSnap.data();
    const numero = String(d.numero || docSnap.id);
    tickets[numero] = {
      numero,
      estatus: (d.estatus as TicketStatus) || 'DISPONIBLE',
      displayName: String(d.displayName || ''),
      cedulaHash: String(d.cedulaHash || ''),
      reservedAtMs: toMillis(d.reservedAt),
      paidAtMs: toMillis(d.paidAt),
      updatedAtMs: toMillis(d.updatedAt) || Date.now(),
    };
  });

  return { payments, contacts, tickets };
}

export async function resolvePaymentInFirestore(
  report: PaymentReportDoc,
  accion: 'APROBADO' | 'RECHAZADO'
): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, 'paymentReports', report.id), {
    estatus: accion,
    resolvedAt: serverTimestamp(),
  });

  if (isSixDigitRef(report.referencia)) {
    const refDoc = doc(db, 'paymentReferences', report.referencia);
    try {
      const refSnap = await getDoc(refDoc);
      if (accion === 'APROBADO') {
        if (refSnap.exists()) {
          batch.update(refDoc, { estatus: 'APROBADO' });
        } else {
          batch.set(refDoc, {
            referencia: report.referencia,
            reportId: report.id,
            estatus: 'APROBADO',
            createdAt: serverTimestamp(),
          });
        }
      } else if (refSnap.exists()) {
        batch.delete(refDoc);
      }
    } catch {
      // Non-fatal if reference doc was absent
    }
  }

  const displayName = maskDisplayName(report.nombre);
  for (const num of report.numeros) {
    if (accion === 'APROBADO') {
      batch.set(doc(db, 'tickets', num), {
        numero: num,
        estatus: 'PAGADO',
        displayName,
        cedulaHash: report.cedulaHash,
        reservedAt: null,
        paidAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(doc(db, 'tickets', num), {
        numero: num,
        estatus: 'RESERVADO',
        displayName,
        cedulaHash: report.cedulaHash,
        reservedAt: serverTimestamp(),
        paidAt: null,
        updatedAt: serverTimestamp(),
      });
    }
    batch.set(doc(db, 'ticketContacts', num), {
      numero: num,
      cedula: report.cedula,
      cedulaHash: report.cedulaHash,
      nombre: report.nombre,
      telefono: report.telefono,
      correo: report.correo,
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `paymentReports/${report.id}`);
  }
}

export async function resyncBoardInFirestore(): Promise<number> {
  const { payments, tickets } = await fetchAdminAllData();
  const desired = new Map<
    string,
    { estatus: TicketStatus; report: PaymentReportDoc }
  >();

  // Oldest first so newer reports take precedence, and APROBADO wins over PENDIENTE
  const chronological = payments.slice().reverse();
  for (const p of chronological) {
    if (p.estatus === 'PENDIENTE') {
      for (const n of p.numeros) {
        const cur = desired.get(n);
        if (!cur || cur.estatus !== 'PAGADO') {
          desired.set(n, { estatus: 'ESPERA', report: p });
        }
      }
    } else if (p.estatus === 'APROBADO') {
      for (const n of p.numeros) {
        desired.set(n, { estatus: 'PAGADO', report: p });
      }
    }
  }

  let cambios = 0;
  const ops: (() => void)[] = [];
  let batch = writeBatch(db);
  let countInBatch = 0;

  const commitIfNeeded = async (force = false) => {
    if (countInBatch >= 400 || (force && countInBatch > 0)) {
      await batch.commit();
      batch = writeBatch(db);
      countInBatch = 0;
    }
  };

  try {
    for (const [num, target] of desired.entries()) {
      const existing = tickets[num];
      if (!existing || existing.estatus !== target.estatus) {
        batch.set(doc(db, 'tickets', num), {
          numero: num,
          estatus: target.estatus,
          displayName: maskDisplayName(target.report.nombre),
          cedulaHash: target.report.cedulaHash,
          reservedAt: null,
          paidAt: target.estatus === 'PAGADO' ? serverTimestamp() : null,
          updatedAt: serverTimestamp(),
        });
        batch.set(doc(db, 'ticketContacts', num), {
          numero: num,
          cedula: target.report.cedula,
          cedulaHash: target.report.cedulaHash,
          nombre: target.report.nombre,
          telefono: target.report.telefono,
          correo: target.report.correo,
          updatedAt: serverTimestamp(),
        });
        countInBatch += 2;
        cambios++;
        await commitIfNeeded();
      }
    }
    await commitIfNeeded(true);
    void ops;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'tickets');
  }
  return cambios;
}

export async function releaseAllReservedInFirestore(): Promise<number> {
  const { tickets } = await fetchAdminAllData();
  const toRelease = Object.values(tickets).filter((t) => t.estatus === 'RESERVADO');
  let released = 0;
  let batch = writeBatch(db);
  let ops = 0;

  try {
    for (const t of toRelease) {
      batch.delete(doc(db, 'tickets', t.numero));
      batch.delete(doc(db, 'ticketContacts', t.numero));
      ops += 2;
      released++;
      if (ops >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, 'tickets');
  }
  return released;
}

export async function releaseSingleTicketInFirestore(numero: string): Promise<void> {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'tickets', numero));
  batch.delete(doc(db, 'ticketContacts', numero));
  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `tickets/${numero}`);
  }
}

export async function editTicketInFirestore(params: {
  numero: string;
  estatus: TicketStatus;
  cedula: string;
  nombre: string;
  telefono: string;
  correo: string;
}): Promise<void> {
  if (params.estatus === 'DISPONIBLE') {
    await releaseSingleTicketInFirestore(params.numero);
    return;
  }

  const rawCed = normalizeDigits(params.cedula).slice(0, 20);
  const rawNom = clampStr(params.nombre, 100);
  const rawTel = clampStr(params.telefono, 25);
  const rawCor = clampStr(params.correo, 120);
  const cedula = rawCed.length >= 4 ? rawCed : '0000';
  const nombre = rawNom.length >= 2 ? rawNom : 'Participante';
  const telefono = rawTel.length >= 7 ? rawTel : '0000000';
  const correo = rawCor.length >= 5 ? rawCor : 'sin@correo.com';
  const cedulaHash = await sha256Hex(cedula);

  const batch = writeBatch(db);
  batch.set(doc(db, 'tickets', params.numero), {
    numero: params.numero,
    estatus: params.estatus,
    displayName: maskDisplayName(nombre),
    cedulaHash,
    reservedAt: params.estatus === 'RESERVADO' ? serverTimestamp() : null,
    paidAt: params.estatus === 'PAGADO' ? serverTimestamp() : null,
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'ticketContacts', params.numero), {
    numero: params.numero,
    cedula,
    cedulaHash,
    nombre,
    telefono,
    correo,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `tickets/${params.numero}`);
  }
}

export async function resetRaffleInFirestore(): Promise<void> {
  const [tSnap, cSnap, pSnap, rSnap] = await Promise.all([
    getDocs(publicTicketsQuery()).catch((e) =>
      handleFirestoreError(e, OperationType.LIST, 'tickets')
    ),
    getDocs(adminTicketContactsQuery()).catch((e) =>
      handleFirestoreError(e, OperationType.LIST, 'ticketContacts')
    ),
    getDocs(adminPaymentReportsQuery()).catch((e) =>
      handleFirestoreError(e, OperationType.LIST, 'paymentReports')
    ),
    getDocs(adminPaymentReferencesQuery()).catch((e) =>
      handleFirestoreError(e, OperationType.LIST, 'paymentReferences')
    ),
  ]);

  const refs = [
    ...tSnap.docs.map((d) => d.ref),
    ...cSnap.docs.map((d) => d.ref),
    ...pSnap.docs.map((d) => d.ref),
    ...rSnap.docs.map((d) => d.ref),
  ];

  try {
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(db);
      for (const ref of refs.slice(i, i + 400)) {
        batch.delete(ref);
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, 'tickets');
  }
}
