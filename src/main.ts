import type { User } from 'firebase/auth';
import {
  ADMIN_BOOTSTRAP_EMAIL,
  checkIsCurrentUserAdmin,
  observeAuth,
  signInAdminWithGoogle,
  signOutAdmin,
  testConnection,
} from './firebase';
import {
  DEFAULT_RAFFLE_CONFIG,
  compressReceiptImage,
  editTicketInFirestore,
  ensureConfigSeeded,
  fetchAdminAllData,
  fetchLiveBcvRate,
  normalizeDigits,
  releaseAllReservedInFirestore,
  releaseSingleTicketInFirestore,
  reserveTicketsInFirestore,
  resetRaffleInFirestore,
  resolvePaymentInFirestore,
  resyncBoardInFirestore,
  saveRaffleConfigInFirestore,
  sha256Hex,
  submitPaymentReportInFirestore,
  subscribeRaffleConfig,
  subscribeTickets,
  type PaymentMethodLabel,
  type PaymentReportDoc,
  type RaffleConfigData,
  type TicketContactDoc,
  type TicketDoc,
  type TicketStatus,
} from './raffleService';

const CACHE_KEY = 'mega_rifas_fb_cache_v1';
const MY_PROFILE_KEY = 'mega_rifas_my_profile_v1';
const METODOS_USD = new Set(['BZ', 'ZP', 'EF', 'US']);

interface LocalCachePayload {
  ts: number;
  config: RaffleConfigData;
  tickets: Record<string, TicketDoc>;
}

interface LookupResult {
  cedula: string;
  cedulaHash: string;
  displayName: string;
  pagados: string[];
  espera: string[];
  reservados: string[];
  deudaUSD: number;
  deudaBs: number;
  diasRestantes: number | null;
  fechaLimite: string;
}

interface AdminCache {
  payments: PaymentReportDoc[];
  contacts: Record<string, TicketContactDoc>;
  tickets: Record<string, TicketDoc>;
}

interface WaPayload {
  nombre: string;
  numeros: string;
  ref: string;
  monto: string;
}

type PaymentMethodCode = 'PM' | 'TR' | 'BZ' | 'ZP' | 'EF' | 'US';

const METHOD_LABELS: Record<PaymentMethodCode, PaymentMethodLabel> = {
  PM: 'Pago Móvil',
  TR: 'Transferencia',
  BZ: 'Binance',
  ZP: 'Zelle',
  EF: 'Efectivo',
  US: 'USDT',
};

let currentConfig: RaffleConfigData = { ...DEFAULT_RAFFLE_CONFIG };
let liveBcvRate: number | null = null;
let currentTickets: Record<string, TicketDoc> = {};
let seleccionados: string[] = [];
let modoCheckoutActual: 'RESERVADO' | 'PAGAR' = 'RESERVADO';
let metodoPagoActual: PaymentMethodCode = 'PM';
let participanteConsultado: LookupResult | null = null;
let historialFiltro: 'TODOS' | 'PAGADO' | 'ESPERA' | 'RESERVADO' = 'TODOS';
let lastBoardSignature = '';
let cfgDirty = false;
let currentAdminUser: User | null = null;
let isCurrentUserAdmin = false;
let adminDataCache: AdminCache | null = null;
let confirmCallback: ((ok: boolean) => void) | null = null;
let waData: WaPayload | null = null;
let activeAdminTab: 'val' | 'vnc' | 'his' | 'cfg' | 'nue' = 'val';
let configExistsInDb = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function escHtml(str: unknown): string {
  return String(str === undefined || str === null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(n: unknown): string {
  const num = Number(n);
  if (!isFinite(num)) return '0,00';
  const p = num.toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return p.join(',');
}

function parseLocaleNumber(val: string): number {
  const cleaned = val.trim().replace(',', '.');
  if (!cleaned) return NaN;
  const n = Number(cleaned);
  return isFinite(n) ? n : NaN;
}

function getEffectiveRate(): number {
  if (currentConfig.tasaManual > 0) return currentConfig.tasaManual;
  if (liveBcvRate && liveBcvRate > 0) return liveBcvRate;
  return currentConfig.tasa > 0 ? currentConfig.tasa : 0;
}

function getTicketPriceBs(): number {
  const rate = getEffectiveRate();
  return Number((currentConfig.precioTicketUSD * rate).toFixed(2));
}

function parseFechaSorteoDays(fechaStr: string): number | null {
  const clean = fechaStr.trim();
  if (!clean) return null;
  let day = 0;
  let month = 0;
  let year = 0;
  const dmy = clean.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const ymd = clean.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (dmy) {
    day = parseInt(dmy[1], 10);
    month = parseInt(dmy[2], 10);
    year = parseInt(dmy[3], 10);
  } else if (ymd) {
    year = parseInt(ymd[1], 10);
    month = parseInt(ymd[2], 10);
    day = parseInt(ymd[3], 10);
  } else {
    return null;
  }
  const target = new Date(year, month - 1, day, 23, 59, 59);
  if (isNaN(target.getTime())) return null;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.ceil((target.getTime() - todayStart.getTime()) / 86400000) - 1;
}

function isReservationAllowed(): boolean {
  const dias = parseFechaSorteoDays(currentConfig.fechaSorteo);
  if (dias === null) return true;
  return dias > currentConfig.diasBloqueo;
}

function formatDateShort(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatDateTime(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${min}`;
}

function haceTiempo(ts: number): string {
  if (!ts) return 'hace poco';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  return `hace ${Math.floor(hrs / 24)} d`;
}

function formatErrorMessage(err: unknown, scope: 'public' | 'admin' = 'public'): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed.error) {
      if (parsed.error.includes('Quota exceeded')) {
        return 'Cuota diaria de Firestore alcanzada. Se restablece mañana.';
      }
      if (
        parsed.error.includes('permission-denied') ||
        parsed.error.includes('Missing or insufficient permissions')
      ) {
        return scope === 'admin'
          ? 'Sin permisos suficientes. Verifica que iniciaste sesión con tu cuenta Admin.'
          : 'No se pudo completar la operación en este momento. Verifica tus datos e intenta de nuevo.';
      }
      return parsed.error;
    }
  } catch {
    // Plain message
  }
  if (raw.includes('permission-denied') || raw.includes('Missing or insufficient permissions')) {
    return scope === 'admin'
      ? 'Sin permisos suficientes. Verifica que iniciaste sesión con tu cuenta Admin.'
      : 'No se pudo completar la operación en este momento. Verifica tus datos e intenta de nuevo.';
  }
  return raw;
}

/* ==================== UI HELPERS ==================== */

function abrirModal(id: string): void {
  const el = $(id);
  if (!el) return;
  el.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function cerrarModal(id: string): void {
  const el = $(id);
  if (!el) return;
  el.classList.add('hidden');
  const abiertos = document.querySelectorAll('.m-bg:not(.hidden)');
  if (!abiertos.length) document.body.style.overflow = '';
}

function setBtnLoading(btn: HTMLButtonElement | null, loading: boolean, text = 'Procesando...'): void {
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escHtml(text)}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.origHtml) {
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
    }
  }
}

function notificar(msg: string, tipo: 'info' | 'success' | 'error' | 'warn' = 'info'): void {
  const wrap = $('toastWrap');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  const icono =
    tipo === 'success'
      ? 'fa-circle-check'
      : tipo === 'error'
      ? 'fa-circle-exclamation'
      : tipo === 'warn'
      ? 'fa-triangle-exclamation'
      : 'fa-circle-info';
  t.innerHTML = `<i class="fa-solid ${icono} mt-0.5 shrink-0"></i><span>${escHtml(msg)}</span>`;
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .25s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 260);
  }, tipo === 'error' || tipo === 'warn' ? 6500 : 4200);
}

function mostrarConfirm(
  titulo: string,
  textoHtml: string,
  icono: string,
  callback: (ok: boolean) => void,
  peligroso = false
): void {
  const tEl = $('confirmTitulo');
  const txtEl = $('confirmTexto');
  const icI = $('confirmIconI');
  const icBox = $('confirmIcon');
  const okBtn = $('confirmBtnOk');
  if (tEl) tEl.textContent = titulo;
  if (txtEl) txtEl.innerHTML = textoHtml;
  if (icI) icI.className = `fa-solid ${icono || 'fa-question'} ${peligroso ? 'text-rose-600' : 'text-amber-600'}`;
  if (icBox) {
    icBox.className = `w-14 h-14 rounded-2xl ${peligroso ? 'bg-rose-100' : 'bg-amber-100'} flex items-center justify-center text-2xl mx-auto mb-3`;
  }
  if (okBtn) okBtn.className = peligroso ? 'btn-danger flex-1' : 'btn-primary flex-1';
  confirmCallback = callback;
  abrirModal('modalConfirm');
}

function cerrarConfirm(ok: boolean): void {
  cerrarModal('modalConfirm');
  const cb = confirmCallback;
  confirmCallback = null;
  if (cb) cb(ok);
}

/* ==================== CACHE ==================== */

function leerCacheLocal(): LocalCachePayload | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalCachePayload;
    if (parsed && parsed.config && parsed.tickets) return parsed;
  } catch {
    // ignore corrupt cache
  }
  return null;
}

function guardarCacheLocal(): void {
  try {
    const payload: LocalCachePayload = {
      ts: Date.now(),
      config: currentConfig,
      tickets: currentTickets,
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage quota
  }
}

function leerMiPerfilLocal(): { cedula: string; nombre: string; telefono: string; correo: string } | null {
  try {
    const raw = localStorage.getItem(MY_PROFILE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as { cedula: string; nombre: string; telefono: string; correo: string };
  } catch {
    return null;
  }
}

function guardarMiPerfilLocal(p: { cedula: string; nombre: string; telefono: string; correo: string }): void {
  try {
    localStorage.setItem(MY_PROFILE_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}

/* ==================== RENDERIZADO PRINCIPAL ==================== */

function depurarSeleccionados(): void {
  if (!seleccionados.length) return;
  const total = currentConfig.totalNumeros;
  const dig = total >= 1000 ? 3 : 2;
  const myReserved = participanteConsultado?.reservados || [];

  seleccionados = seleccionados.filter((num) => {
    const idx = parseInt(num, 10);
    if (!isFinite(idx) || idx < 0 || idx >= total) return false;
    if (String(idx).padStart(dig, '0') !== num) return false;
    const est = currentTickets[num]?.estatus || 'DISPONIBLE';
    if (est === 'DISPONIBLE') return true;
    if (est === 'RESERVADO' && myReserved.includes(num)) return true;
    return false;
  });
}

function renderAll(): void {
  const cfg = currentConfig;
  const priceBs = getTicketPriceBs();

  const subtitulo = cfg.tituloRifa || 'JUEGA Y GANA';
  const subEl = $('txtSubtituloRifa');
  if (subEl) subEl.textContent = subtitulo;
  document.title = cfg.tituloRifa ? `Mega Rifas · ${cfg.tituloRifa}` : 'Mega Rifas';

  const bsEl = $('badgePrecioBs');
  const usdEl = $('badgePrecioUSD');
  if (bsEl) bsEl.textContent = priceBs > 0 ? `Bs ${fmt(priceBs)}` : 'Bs --';
  if (usdEl) usdEl.textContent = `$${fmt(cfg.precioTicketUSD)} · por boleto`;

  const premiosEl = $('txtPremiosHeader');
  if (premiosEl) premiosEl.textContent = cfg.premios || 'Premios por anunciar';

  const noticiasEl = $('txtNoticiasDisplay');
  if (noticiasEl) {
    if (cfg.noticias) {
      noticiasEl.textContent = cfg.noticias;
      noticiasEl.classList.remove('hidden');
    } else {
      noticiasEl.textContent = '';
      noticiasEl.classList.add('hidden');
    }
  }

  // Ticker
  const tickerRaw = cfg.tickerNoticias || cfg.noticias || '¡Bienvenidos a Mega Rifas!';
  const tickerItems = tickerRaw
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  const items = tickerItems.length ? tickerItems : [tickerRaw];
  let htmlTicker = '';
  for (let k = 0; k < 2; k++) {
    for (const it of items) {
      htmlTicker += `<span>• ${escHtml(it)}</span>`;
    }
  }
  const tickerEl = $('tickerContent');
  if (tickerEl) tickerEl.innerHTML = htmlTicker;

  // Draw countdown
  const diasSorteo = parseFechaSorteoDays(cfg.fechaSorteo);
  const alertaEl = $('alertaSorteo');
  if (alertaEl) {
    if (diasSorteo !== null) {
      alertaEl.classList.remove('hidden');
      alertaEl.textContent = diasSorteo <= 0 ? '🎉 HOY' : `${diasSorteo}d`;
    } else {
      alertaEl.classList.add('hidden');
    }
  }

  const btnRes = $('btnReservarFlotante');
  if (btnRes) btnRes.classList.toggle('hidden', !isReservationAllowed());

  // Stats, Top 3 & Feed computed live from tickets
  const total = cfg.totalNumeros;
  const dig = total >= 1000 ? 3 : 2;
  let vendidos = 0;
  let reservados = 0;
  let espera = 0;
  const buyerCounts = new Map<string, { displayName: string; cantidad: number }>();
  const feedItems: { nombre: string; numero: string; estatus: TicketStatus; ts: number }[] = [];

  for (let i = 0; i < total; i++) {
    const num = String(i).padStart(dig, '0');
    const t = currentTickets[num];
    if (!t || t.estatus === 'DISPONIBLE') continue;
    if (t.estatus === 'PAGADO') {
      vendidos++;
      const key = t.cedulaHash || t.displayName;
      const prev = buyerCounts.get(key);
      if (prev) prev.cantidad++;
      else buyerCounts.set(key, { displayName: t.displayName || 'Participante', cantidad: 1 });
      feedItems.push({
        nombre: t.displayName || 'Participante',
        numero: num,
        estatus: 'PAGADO',
        ts: t.paidAtMs || t.updatedAtMs,
      });
    } else if (t.estatus === 'ESPERA') {
      espera++;
      feedItems.push({
        nombre: t.displayName || 'Participante',
        numero: num,
        estatus: 'ESPERA',
        ts: t.updatedAtMs,
      });
    } else if (t.estatus === 'RESERVADO') {
      reservados++;
    }
  }

  const ocupados = vendidos + espera + reservados;
  const pct = total > 0 ? Math.round((ocupados / total) * 100) : 0;
  const restantes = Math.max(0, total - ocupados);

  const pctEl = $('txtPorcentajeGeneral');
  const barEl = $('barraProgreso');
  const detEl = $('txtProgresoDetalle');
  const urgEl = $('txtProgresoUrgente');
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (barEl) barEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (detEl) detEl.textContent = `${ocupados} de ${total} boletos`;
  if (urgEl) {
    if (restantes <= 0) urgEl.textContent = '¡AGOTADO!';
    else if (restantes <= 10) urgEl.textContent = `🔥 ¡Quedan ${restantes}!`;
    else if (restantes <= 30) urgEl.textContent = `⚡ Quedan ${restantes}`;
    else urgEl.textContent = `✅ ${restantes} disponibles`;
  }

  const top3 = Array.from(buyerCounts.values())
    .sort((a, b) => b.cantidad - a.cantidad)
    .slice(0, 3);
  renderizarTop(top3);

  feedItems.sort((a, b) => b.ts - a.ts);
  renderizarFeed(feedItems.slice(0, 15));

  renderizarSoporte(cfg.waList, cfg.igUrl);
  depurarSeleccionados();
  renderizarTablero();
  actualizarBarraFlotante();

  if (participanteConsultado) {
    recomputarConsultaParticipante(participanteConsultado.cedula, participanteConsultado.cedulaHash);
  }

  const panelAbierto = !$('modalPanelAdmin')?.classList.contains('hidden');
  if (panelAbierto && !cfgDirty) {
    cargarFormularioConfigAdmin();
  }
}

function renderizarTop(top: { displayName: string; cantidad: number }[]): void {
  const c = $('listaTopCompradores');
  if (!c) return;
  if (!top.length) {
    c.className = 'text-center';
    c.innerHTML = '<span class="text-slate-400 text-xs">Aún sin compradores.</span>';
    return;
  }
  c.className = 'space-y-1.5';
  const med = ['🥇', '🥈', '🥉'];
  c.innerHTML = top
    .map(
      (t, i) =>
        `<div class="top-mini"><span class="text-sm">${med[i] || '🏅'}</span><span class="text-xs font-black text-slate-800 truncate flex-1 text-left">${escHtml(t.displayName)}</span><span class="text-xs font-black text-amber-600 font-mono">${t.cantidad} 🎟️</span></div>`
    )
    .join('');
}

function renderizarFeed(
  feed: { nombre: string; numero: string; estatus: TicketStatus; ts: number }[]
): void {
  const sec = $('feedSection');
  const content = $('feedContent');
  if (!sec || !content) return;
  if (!feed.length) {
    sec.classList.add('hidden');
    return;
  }
  sec.classList.remove('hidden');
  let html = '';
  for (let k = 0; k < 2; k++) {
    for (const it of feed) {
      const emoji = it.estatus === 'PAGADO' ? '🟢' : '🟣';
      html += `<span>${emoji} <b>${escHtml(it.nombre)}</b> compró <span class="feed-num">#${escHtml(it.numero)}</span> <span class="feed-time">· ${escHtml(haceTiempo(it.ts))}</span></span>`;
    }
  }
  content.innerHTML = html;
}

function renderizarSoporte(waList: string[], igUrl: string): void {
  const c = $('contenedorBotonesSoporte');
  if (!c) return;
  let html = '';
  const msg = encodeURIComponent('¡Hola! 👋 Vengo de Mega Rifas 🎟️✨');
  const validWa = waList.map(normalizeDigits).filter(Boolean);
  validWa.forEach((tel, i) => {
    const label = validWa.length > 1 ? `WhatsApp ${i + 1}` : 'WhatsApp';
    html += `<a href="https://wa.me/${tel}?text=${msg}" target="_blank" rel="noopener noreferrer" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2 px-3.5 rounded-xl text-xs inline-flex items-center gap-1.5 transition"><i class="fa-brands fa-whatsapp text-sm"></i> ${label}</a>`;
  });
  if (igUrl.trim()) {
    const raw = igUrl.trim();
    const href = /^https?:\/\//i.test(raw) ? raw : `https://instagram.com/${raw.replace(/^@/, '')}`;
    html += `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer" class="bg-slate-900 hover:bg-slate-800 text-white font-bold py-2 px-3.5 rounded-xl text-xs inline-flex items-center gap-1.5 transition"><i class="fa-brands fa-instagram text-sm text-pink-400"></i> Instagram</a>`;
  }
  c.innerHTML = html || '<span class="text-slate-500 text-xs">Sin canales de soporte configurados.</span>';
}

function renderizarTablero(force = false): void {
  const grid = $('gridTablero');
  if (!grid) return;
  const total = currentConfig.totalNumeros;
  const dig = total >= 1000 ? 3 : 2;
  const statusList: string[] = [];
  for (let i = 0; i < total; i++) {
    const num = String(i).padStart(dig, '0');
    statusList.push(currentTickets[num]?.estatus || 'DISPONIBLE');
  }
  const sig = `${total}:${statusList.join(',')}`;
  if (!force && sig === lastBoardSignature && grid.children.length === total) {
    sincronizarClasesSeleccionTablero();
    return;
  }
  lastBoardSignature = sig;

  const selSet = new Set(seleccionados);
  const parts = new Array<string>(total);
  for (let i = 0; i < total; i++) {
    const numStr = String(i).padStart(dig, '0');
    const est = statusList[i];
    const clase = est === 'DISPONIBLE' && selSet.has(numStr) ? 'num-SELECCIONADO' : `num-${est}`;
    const disabled = est !== 'DISPONIBLE' ? ' disabled' : '';
    parts[i] = `<button type="button" data-num="${numStr}" data-est="${est}" class="num-btn ${clase}"${disabled}>${numStr}</button>`;
  }
  grid.innerHTML = parts.join('');
}

function sincronizarClasesSeleccionTablero(): void {
  const grid = $('gridTablero');
  if (!grid) return;
  const selSet = new Set(seleccionados);
  grid.querySelectorAll<HTMLButtonElement>('button[data-num]').forEach((btn) => {
    if (btn.dataset.est === 'DISPONIBLE') {
      const isSel = selSet.has(btn.dataset.num || '');
      btn.classList.toggle('num-SELECCIONADO', isSel);
      btn.classList.toggle('num-DISPONIBLE', !isSel);
    }
  });
}

function actualizarBotonNumero(num: string): void {
  const btn = $('gridTablero')?.querySelector<HTMLButtonElement>(`button[data-num="${num}"]`);
  if (!btn || btn.dataset.est !== 'DISPONIBLE') return;
  const isSel = seleccionados.includes(num);
  btn.classList.toggle('num-SELECCIONADO', isSel);
  btn.classList.toggle('num-DISPONIBLE', !isSel);
}

function tocarNumero(num: string, est: string): void {
  if (est === 'PAGADO') {
    notificar('Este número ya fue pagado', 'error');
    return;
  }
  if (est === 'ESPERA') {
    notificar('Este número está en revisión', 'error');
    return;
  }
  if (est === 'RESERVADO') {
    notificar('Este número ya está reservado', 'error');
    return;
  }
  const idx = seleccionados.indexOf(num);
  if (idx > -1) seleccionados.splice(idx, 1);
  else seleccionados.push(num);
  actualizarBotonNumero(num);
  actualizarBarraFlotante();
  if (participanteConsultado) renderizarResultadoConsulta(participanteConsultado);
}

function limpiarSeleccion(): void {
  seleccionados = [];
  sincronizarClasesSeleccionTablero();
  actualizarBarraFlotante();
  if (participanteConsultado) renderizarResultadoConsulta(participanteConsultado);
}

function actualizarBarraFlotante(): void {
  const barra = $('barraAccionFlotante');
  const sticky = $('stickyTopBtn');
  const btnLimpiar = $('btnLimpiarSel');
  if (!barra || !sticky || !btnLimpiar) return;

  if (seleccionados.length > 0) {
    const totalBs = seleccionados.length * getTicketPriceBs();
    barra.classList.remove('hidden');
    sticky.classList.remove('hidden');
    btnLimpiar.classList.remove('hidden');
    const cBadge = $('txtCantSeleccionadosBadge');
    const tBot = $('txtTotalBsBottom');
    const sCant = $('stickyTopCant');
    const sTot = $('stickyTopTotal');
    if (cBadge) cBadge.textContent = String(seleccionados.length);
    if (tBot) tBot.textContent = `Bs ${fmt(totalBs)}`;
    if (sCant) sCant.textContent = String(seleccionados.length);
    if (sTot) sTot.textContent = `Bs ${fmt(totalBs)}`;
  } else {
    barra.classList.add('hidden');
    sticky.classList.add('hidden');
    btnLimpiar.classList.add('hidden');
  }
}

function seleccionarAzar(): void {
  const total = currentConfig.totalNumeros;
  const dig = total >= 1000 ? 3 : 2;
  const selSet = new Set(seleccionados);
  const disp: string[] = [];
  for (let i = 0; i < total; i++) {
    const s = String(i).padStart(dig, '0');
    const est = currentTickets[s]?.estatus || 'DISPONIBLE';
    if (est === 'DISPONIBLE' && !selSet.has(s)) disp.push(s);
  }
  if (!disp.length) {
    notificar('No hay números disponibles', 'error');
    return;
  }
  tocarNumero(disp[Math.floor(Math.random() * disp.length)], 'DISPONIBLE');
}

/* ==================== CONSULTA POR CÉDULA (CERO PII EXPUESTA) ==================== */

async function consultarParticipante(): Promise<void> {
  const input = $<HTMLInputElement>('inputCedulaConsulta');
  const cedula = normalizeDigits(input?.value || '');
  if (cedula.length < 4) {
    notificar('Ingresa una cédula válida', 'error');
    return;
  }
  const hash = await sha256Hex(cedula);
  recomputarConsultaParticipante(cedula, hash);
}

function recomputarConsultaParticipante(cedula: string, cedulaHash: string): void {
  const pagados: string[] = [];
  const espera: string[] = [];
  const reservados: string[] = [];
  let displayName = '';
  let earliestReservedMs: number | null = null;

  const sortedTickets = Object.values(currentTickets).sort((a, b) => a.numero.localeCompare(b.numero));
  for (const t of sortedTickets) {
    if (t.cedulaHash !== cedulaHash || t.estatus === 'DISPONIBLE') continue;
    if (!displayName && t.displayName) displayName = t.displayName;
    if (t.estatus === 'PAGADO') pagados.push(t.numero);
    else if (t.estatus === 'ESPERA') espera.push(t.numero);
    else if (t.estatus === 'RESERVADO') {
      reservados.push(t.numero);
      if (t.reservedAtMs && (earliestReservedMs === null || t.reservedAtMs < earliestReservedMs)) {
        earliestReservedMs = t.reservedAtMs;
      }
    }
  }

  let diasRestantes: number | null = null;
  let fechaLimite = '';
  if (reservados.length && earliestReservedMs) {
    const limiteMs = earliestReservedMs + currentConfig.diasLimitePago * 86400000;
    diasRestantes = Math.ceil((limiteMs - Date.now()) / 86400000);
    fechaLimite = formatDateShort(limiteMs);
  }

  const deudaUSD = reservados.length * currentConfig.precioTicketUSD;
  const deudaBs = reservados.length * getTicketPriceBs();

  participanteConsultado = {
    cedula,
    cedulaHash,
    displayName: displayName || 'Participante',
    pagados,
    espera,
    reservados,
    deudaUSD,
    deudaBs,
    diasRestantes,
    fechaLimite,
  };
  renderizarResultadoConsulta(participanteConsultado);
}

function renderizarResultadoConsulta(res: LookupResult): void {
  const box = $('resultadoConsultaParticipante');
  if (!box) return;
  box.classList.remove('hidden');

  const tieneAlguno = res.pagados.length + res.espera.length + res.reservados.length > 0;
  if (!tieneAlguno) {
    box.innerHTML =
      '<div class="subcard text-center text-xs text-slate-500 py-3"><i class="fa-solid fa-user-slash mr-1"></i> No se encontraron boletos para esta cédula.</div>';
    return;
  }

  let html = '<div class="subcard space-y-2.5">';
  html += '<div class="flex items-center gap-2.5 pb-2 border-b border-slate-200">';
  html += '<div class="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 text-xs shrink-0"><i class="fa-solid fa-user"></i></div>';
  html += `<div class="min-w-0"><b class="text-xs font-black text-slate-900 block truncate">${escHtml(res.displayName)}</b><span class="text-[10px] font-mono text-slate-500">C.I. ${escHtml(res.cedula)}</span></div></div>`;

  if (res.deudaUSD > 0) {
    html += '<div class="bg-amber-50 border border-amber-200 rounded-xl p-2.5">';
    html += '<div class="text-[10px] font-bold text-amber-700">💳 DEUDA PENDIENTE</div>';
    html += `<b class="text-base font-black text-amber-900 font-mono">Bs ${fmt(res.deudaBs)}</b> <span class="text-xs font-mono text-amber-700">($${fmt(res.deudaUSD)})</span>`;
    if (res.diasRestantes !== null) {
      const color = res.diasRestantes <= 3 ? 'text-rose-600' : 'text-amber-700';
      const label =
        res.diasRestantes < 0
          ? `Vencida hace ${Math.abs(res.diasRestantes)} días`
          : `${res.diasRestantes} días (límite: ${res.fechaLimite})`;
      html += `<div class="text-[11px] font-bold ${color} mt-1">⏰ ${escHtml(label)}</div>`;
    }
    html += '</div>';
  }

  if (res.pagados.length) {
    html += `<div><div class="text-[10px] font-black text-slate-500 mb-1">✅ PAGADOS (${res.pagados.length})</div><div class="flex flex-wrap gap-1">`;
    res.pagados.forEach((n) => {
      html += `<span class="chip paid">${escHtml(n)}</span>`;
    });
    html += '</div></div>';
  }
  if (res.espera.length) {
    html += `<div><div class="text-[10px] font-black text-slate-500 mb-1">🟣 EN REVISIÓN (${res.espera.length})</div><div class="flex flex-wrap gap-1">`;
    res.espera.forEach((n) => {
      html += `<span class="chip esp">${escHtml(n)}</span>`;
    });
    html += '</div></div>';
  }
  if (res.reservados.length) {
    html += `<div><div class="flex justify-between items-center mb-1"><div class="text-[10px] font-black text-slate-500">🔵 RESERVADOS (${res.reservados.length})</div>`;
    html += '<button type="button" data-action="sel-todos-res" class="text-[10px] font-black text-blue-600 underline">Sel. todos</button></div>';
    html += '<div class="flex flex-wrap gap-1">';
    res.reservados.forEach((n) => {
      const on = seleccionados.includes(n);
      html += `<span class="chip reserved ${on ? 'on' : ''}" data-toggle-res="${escHtml(n)}">${escHtml(n)}</span>`;
    });
    html += '</div></div>';
    html += '<button type="button" data-action="pagar-res" class="btn-primary w-full !py-2 !text-xs"><i class="fa-solid fa-credit-card"></i> Pagar seleccionados</button>';
  }
  html += '</div>';
  box.innerHTML = html;
}

function toggleReservado(num: string): void {
  const idx = seleccionados.indexOf(num);
  if (idx > -1) seleccionados.splice(idx, 1);
  else seleccionados.push(num);
  actualizarBarraFlotante();
  if (participanteConsultado) renderizarResultadoConsulta(participanteConsultado);
}

function seleccionarTodosReservados(): void {
  if (!participanteConsultado) return;
  const res = participanteConsultado.reservados;
  const todos = res.every((n) => seleccionados.includes(n));
  if (todos) seleccionados = seleccionados.filter((n) => !res.includes(n));
  else res.forEach((n) => { if (!seleccionados.includes(n)) seleccionados.push(n); });
  actualizarBarraFlotante();
  renderizarResultadoConsulta(participanteConsultado);
}

function pagarReservadosSeleccionados(): void {
  if (!participanteConsultado) return;
  const res = participanteConsultado.reservados;
  const sel = seleccionados.filter((n) => res.includes(n));
  if (!sel.length) {
    notificar('Selecciona al menos un boleto reservado', 'error');
    return;
  }
  const cedEl = $<HTMLInputElement>('chkCedula');
  if (cedEl) cedEl.value = participanteConsultado.cedula;
  const savedProfile = leerMiPerfilLocal();
  if (savedProfile && normalizeDigits(savedProfile.cedula) === participanteConsultado.cedula) {
    const nEl = $<HTMLInputElement>('chkNombre');
    const tEl = $<HTMLInputElement>('chkTelefono');
    const cEl = $<HTMLInputElement>('chkCorreo');
    if (nEl && !nEl.value) nEl.value = savedProfile.nombre;
    if (tEl && !tEl.value) tEl.value = savedProfile.telefono;
    if (cEl && !cEl.value) cEl.value = savedProfile.correo;
  }
  abrirModalCheckout('PAGAR');
}

/* ==================== CHECKOUT ==================== */

function abrirModalCheckout(modo: 'RESERVADO' | 'PAGAR'): void {
  if (!seleccionados.length) {
    notificar('Selecciona al menos un número', 'error');
    return;
  }
  if (modo === 'RESERVADO' && !isReservationAllowed()) {
    notificar('Solo pago directo. Faltan pocos días para el sorteo.', 'warn');
    modo = 'PAGAR';
  }
  modoCheckoutActual = modo;

  // Autofill buyer's own device profile if fields empty
  const savedProfile = leerMiPerfilLocal();
  if (savedProfile) {
    const cedEl = $<HTMLInputElement>('chkCedula');
    const nomEl = $<HTMLInputElement>('chkNombre');
    const telEl = $<HTMLInputElement>('chkTelefono');
    const corEl = $<HTMLInputElement>('chkCorreo');
    if (cedEl && !cedEl.value) cedEl.value = savedProfile.cedula;
    if (nomEl && !nomEl.value) nomEl.value = savedProfile.nombre;
    if (telEl && !telEl.value) telEl.value = savedProfile.telefono;
    if (corEl && !corEl.value) corEl.value = savedProfile.correo;
  }

  const totalUSD = seleccionados.length * currentConfig.precioTicketUSD;
  const totalBs = seleccionados.length * getTicketPriceBs();

  const tit = $('tituloModalCheckout');
  const sub = $('subtituloCheckout');
  const cant = $('chkCantidad');
  const nums = $('chkNumerosTxt');
  const tBs = $('chkTotalBs');
  const tUsd = $('chkTotalUSD');
  if (tit) tit.textContent = modo === 'RESERVADO' ? 'Reservar Boletos' : 'Reportar Pago';
  if (sub) sub.textContent = modo === 'RESERVADO' ? 'Reserva sin pagar ahora' : 'Elige cómo quieres pagar';
  if (cant) cant.textContent = `${seleccionados.length} boleto(s)`;
  if (nums) nums.textContent = `#${seleccionados.join(' · #')}`;
  if (tBs) tBs.textContent = `Bs ${fmt(totalBs)}`;
  if (tUsd) tUsd.textContent = `$${fmt(totalUSD)}`;

  const blq = $('bloqueDatosPago');
  if (modo === 'PAGAR') {
    blq?.classList.remove('hidden');
    cambiarMetodoPago('PM');
  } else {
    blq?.classList.add('hidden');
    tUsd?.classList.add('hidden');
  }
  abrirModal('modalCheckout');
}

function cambiarMetodoPago(met: PaymentMethodCode): void {
  metodoPagoActual = met;
  const metodos: PaymentMethodCode[] = ['PM', 'TR', 'BZ', 'ZP', 'EF', 'US'];
  metodos.forEach((m) => $(`pm${m}`)?.classList.toggle('on', m === met));

  const esUSD = METODOS_USD.has(met);
  const totalUSD = seleccionados.length * currentConfig.precioTicketUSD;
  const totalBs = seleccionados.length * getTicketPriceBs();
  const tBs = $('chkTotalBs');
  const tUsd = $('chkTotalUSD');
  if (esUSD) {
    if (tBs) tBs.textContent = `$${fmt(totalUSD)}`;
    if (tUsd) tUsd.textContent = `≈ Bs ${fmt(totalBs)}`;
  } else {
    if (tBs) tBs.textContent = `Bs ${fmt(totalBs)}`;
    if (tUsd) tUsd.textContent = `≈ $${fmt(totalUSD)}`;
  }
  tUsd?.classList.remove('hidden');

  const box = $('datosPagoVisual');
  if (box) {
    const infoMap: Record<PaymentMethodCode, [string, string]> = {
      PM: ['💳 Pago Móvil', currentConfig.pmDatos || 'No configurado'],
      TR: ['🏦 Transferencia', currentConfig.trDatos || 'No configurado'],
      BZ: ['🪙 Binance Pay', currentConfig.binanceDatos || 'Coordina con soporte.'],
      ZP: ['💜 Zelle', currentConfig.zelleDatos || 'Coordina con soporte.'],
      EF: ['💵 Efectivo', currentConfig.efectivoDatos || 'Coordina con soporte.'],
      US: ['🪙 USDT', currentConfig.usdtDatos || 'Coordina con soporte.'],
    };
    const [label, details] = infoMap[met];
    box.innerHTML = `<b>${label}</b><br>${escHtml(details)}`;
  }

  const blqWA = $('bloqueWhatsAppSoporte');
  const blqRef = $('bloqueRefComprobante');
  if (esUSD) {
    blqWA?.classList.remove('hidden');
    blqRef?.classList.add('hidden');
    const tel = normalizeDigits(currentConfig.waList[0] || '');
    const msg = encodeURIComponent(
      `¡Hola! 👋 Quiero pagar con *${METHOD_LABELS[met]}*.\n\n🎟️ Números: #${seleccionados.join(', #')}\n💰 Monto: *$${fmt(totalUSD)}*\n\n¿Me indican cómo proceder? 🙏`
    );
    const link = $<HTMLAnchorElement>('btnWhatsAppSoporte');
    if (link) link.href = tel ? `https://wa.me/${tel}?text=${msg}` : '#';
  } else {
    blqWA?.classList.add('hidden');
    blqRef?.classList.remove('hidden');
  }
}

async function ejecutarCheckout(): Promise<void> {
  const cedula = normalizeDigits($<HTMLInputElement>('chkCedula')?.value || '');
  const nombre = ($<HTMLInputElement>('chkNombre')?.value || '').trim();
  const telefono = ($<HTMLInputElement>('chkTelefono')?.value || '').trim();
  const correo = ($<HTMLInputElement>('chkCorreo')?.value || '').trim();

  if (cedula.length < 4 || nombre.length < 2 || telefono.length < 7 || !correo.includes('@')) {
    notificar('Completa todos los datos obligatorios correctamente', 'error');
    return;
  }

  guardarMiPerfilLocal({ cedula, nombre, telefono, correo });
  const btn = $<HTMLButtonElement>('btnEjecutarCheckout');

  if (modoCheckoutActual === 'RESERVADO') {
    setBtnLoading(btn, true, 'Reservando...');
    try {
      await reserveTicketsInFirestore({
        cedula,
        nombre,
        telefono,
        correo,
        numeros: seleccionados.slice(),
      });
      seleccionados = [];
      actualizarBarraFlotante();
      cerrarModal('modalCheckout');
      notificar('¡Boletos reservados con éxito! 🎉', 'success');
    } catch (e) {
      notificar(formatErrorMessage(e), 'error');
    } finally {
      setBtnLoading(btn, false);
    }
    return;
  }

  const esUSD = METODOS_USD.has(metodoPagoActual);
  const refInput = ($<HTMLInputElement>('chkReferencia')?.value || '').trim();
  const referencia = esUSD ? `USD${String(Date.now()).slice(-4)}` : refInput;
  if (!esUSD && referencia.length !== 4) {
    notificar('La referencia debe ser de 4 dígitos', 'error');
    return;
  }

  setBtnLoading(btn, true, 'Enviando pago...');
  try {
    let comprobante = '';
    const fileInput = esUSD ? null : $<HTMLInputElement>('chkArchivo');
    if (fileInput?.files && fileInput.files.length > 0) {
      comprobante = await compressReceiptImage(fileInput.files[0]);
    }

    const totalUSD = seleccionados.length * currentConfig.precioTicketUSD;
    const totalBs = seleccionados.length * getTicketPriceBs();

    await submitPaymentReportInFirestore({
      cedula,
      nombre,
      telefono,
      correo,
      numeros: seleccionados.slice(),
      montoUSD: totalUSD,
      montoBs: totalBs,
      metodo: METHOD_LABELS[metodoPagoActual],
      referencia,
      comprobante,
      currentTickets,
    });

    seleccionados = [];
    const rEl = $<HTMLInputElement>('chkReferencia');
    if (rEl) rEl.value = '';
    if (fileInput) fileInput.value = '';
    actualizarBarraFlotante();
    cerrarModal('modalCheckout');
    notificar('¡Pago reportado! Quedó en revisión 🎉', 'success');
  } catch (e) {
    notificar(formatErrorMessage(e), 'error');
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ==================== ADMIN AUTH & PANEL ==================== */

function mostrarErrorAuthAdmin(msg: string): void {
  const errEl = $('adminAuthError');
  if (!errEl) return;
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}

function exigirSesionAdminEnPanel(): boolean {
  if (isCurrentUserAdmin && currentAdminUser) return true;
  cerrarModal('modalPanelAdmin');
  mostrarErrorAuthAdmin(
    'Inicia sesión con tu cuenta de Google autorizada para acceder al Panel Admin.'
  );
  abrirModal('modalAuthAdmin');
  return false;
}

async function abrirModalAdminSeguro(): Promise<void> {
  const errEl = $('adminAuthError');
  if (errEl) {
    errEl.classList.add('hidden');
    errEl.textContent = '';
  }
  if (currentAdminUser) {
    isCurrentUserAdmin = await checkIsCurrentUserAdmin(currentAdminUser);
    if (isCurrentUserAdmin) {
      abrirPanelAdmin();
      return;
    }
    mostrarErrorAuthAdmin(
      `La cuenta ${currentAdminUser.email || ''} no tiene permisos de administrador (cuenta autorizada: ${ADMIN_BOOTSTRAP_EMAIL}). Inicia sesión con otra cuenta.`
    );
  }
  abrirModal('modalAuthAdmin');
}

async function iniciarSesionAdminGoogle(): Promise<void> {
  const btn = $<HTMLButtonElement>('btnLoginGoogleAdmin');
  const errEl = $('adminAuthError');
  if (errEl) errEl.classList.add('hidden');
  setBtnLoading(btn, true, 'Conectando con Google...');
  try {
    const user = await signInAdminWithGoogle();
    const ok = await checkIsCurrentUserAdmin(user);
    currentAdminUser = user;
    isCurrentUserAdmin = ok;
    if (!ok) {
      await signOutAdmin();
      currentAdminUser = null;
      isCurrentUserAdmin = false;
      const msg = `La cuenta ${user.email || ''} no tiene permisos de administrador (cuenta autorizada: ${ADMIN_BOOTSTRAP_EMAIL}).`;
      mostrarErrorAuthAdmin(msg);
      return;
    }
    cerrarModal('modalAuthAdmin');
    if (!configExistsInDb) {
      await ensureConfigSeeded(currentConfig).catch(() => undefined);
    }
    abrirPanelAdmin();
    notificar(`Bienvenido Admin (${user.email}) 👋`, 'success');
  } catch (e) {
    const msg = formatErrorMessage(e, 'admin');
    mostrarErrorAuthAdmin(msg);
  } finally {
    setBtnLoading(btn, false);
  }
}

async function cerrarSesionAdmin(): Promise<void> {
  await signOutAdmin();
  currentAdminUser = null;
  isCurrentUserAdmin = false;
  adminDataCache = null;
  cerrarModal('modalPanelAdmin');
  notificar('Sesión de administrador cerrada', 'info');
}

function abrirPanelAdmin(): void {
  if (!isCurrentUserAdmin || !currentAdminUser) {
    abrirModal('modalAuthAdmin');
    return;
  }
  const emailBadge = $('adminEmailBadge');
  if (emailBadge && currentAdminUser.email) {
    emailBadge.textContent = currentAdminUser.email;
  }
  if (!configExistsInDb) {
    void ensureConfigSeeded(currentConfig).catch(() => undefined);
  }
  cfgDirty = false;
  ocultarFeedbackConfig();
  abrirModal('modalPanelAdmin');
  cambiarTabAdmin('val');
  cargarFormularioConfigAdmin();
}

function cambiarTabAdmin(tab: 'val' | 'vnc' | 'his' | 'cfg' | 'nue'): void {
  activeAdminTab = tab;
  $('adminViewVal')?.classList.toggle('hidden', tab !== 'val');
  $('adminViewVnc')?.classList.toggle('hidden', tab !== 'vnc');
  $('adminViewHis')?.classList.toggle('hidden', tab !== 'his');
  $('adminViewCfg')?.classList.toggle('hidden', tab !== 'cfg');
  $('adminViewNue')?.classList.toggle('hidden', tab !== 'nue');

  const tVal = $('adminTabVal');
  const tVnc = $('adminTabVnc');
  const tHis = $('adminTabHis');
  const tCfg = $('adminTabCfg');
  const tNue = $('adminTabNue');
  if (tVal) tVal.className = `tab-btn ${tab === 'val' ? 'tab-on' : 'tab-off'}`;
  if (tVnc) tVnc.className = `tab-btn ${tab === 'vnc' ? 'tab-warn-on' : 'tab-warn-off'}`;
  if (tHis) tHis.className = `tab-btn ${tab === 'his' ? 'tab-on' : 'tab-off'}`;
  if (tCfg) tCfg.className = `tab-btn ${tab === 'cfg' ? 'tab-on' : 'tab-off'}`;
  if (tNue) tNue.className = `tab-btn ${tab === 'nue' ? 'tab-danger-on' : 'tab-danger-off'}`;

  if (tab === 'val') void cargarPagosPendientesAdmin();
  if (tab === 'vnc') void cargarPorVencerAdmin();
  if (tab === 'his') void cargarHistorialAdmin();
  if (tab === 'cfg' && !cfgDirty) cargarFormularioConfigAdmin();
}

async function refrescarDatosAdmin(): Promise<AdminCache> {
  if (!isCurrentUserAdmin || !currentAdminUser) {
    throw new Error('Sin permisos suficientes. Verifica que iniciaste sesión con tu cuenta Admin.');
  }
  const data = await fetchAdminAllData();
  adminDataCache = data;
  return data;
}

function computeVencimientos(data: AdminCache) {
  const grouped = new Map<
    string,
    {
      cedula: string;
      nombre: string;
      telefono: string;
      correo: string;
      numeros: string[];
      earliestMs: number;
    }
  >();

  Object.values(data.tickets).forEach((t) => {
    if (t.estatus !== 'RESERVADO') return;
    const c = data.contacts[t.numero];
    const key = t.cedulaHash || t.numero;
    const ts = t.reservedAtMs || t.updatedAtMs;
    const prev = grouped.get(key);
    if (prev) {
      prev.numeros.push(t.numero);
      if (ts < prev.earliestMs) prev.earliestMs = ts;
    } else {
      grouped.set(key, {
        cedula: c?.cedula || '—',
        nombre: c?.nombre || t.displayName || 'Participante',
        telefono: c?.telefono || '',
        correo: c?.correo || '',
        numeros: [t.numero],
        earliestMs: ts,
      });
    }
  });

  const list = Array.from(grouped.values())
    .map((item) => {
      const limiteMs = item.earliestMs + currentConfig.diasLimitePago * 86400000;
      const diasRestantes = Math.ceil((limiteMs - Date.now()) / 86400000);
      return {
        ...item,
        numeros: item.numeros.sort(),
        diasRestantes,
        vencida: diasRestantes < 0,
      };
    })
    .filter((item) => item.diasRestantes <= 3)
    .sort((a, b) => a.diasRestantes - b.diasRestantes);

  return list;
}

async function cargarPagosPendientesAdmin(): Promise<void> {
  if (!exigirSesionAdminEnPanel()) return;
  const cont = $('adminViewVal');
  if (!cont) return;
  cont.innerHTML =
    '<div class="subcard text-center text-slate-500 py-4 text-xs"><i class="fa-solid fa-spinner fa-spin mr-1"></i> Cargando pagos y estadísticas...</div>';

  try {
    const data = await refrescarDatosAdmin();
    const hoyInicio = new Date();
    hoyInicio.setHours(0, 0, 0, 0);
    const hoyMs = hoyInicio.getTime();

    const aprobados = data.payments.filter((p) => p.estatus === 'APROBADO');
    const pendientes = data.payments.filter((p) => p.estatus === 'PENDIENTE');
    const totalUSD = aprobados.reduce((acc, p) => acc + p.montoUSD, 0);
    const totalBs = totalUSD * getEffectiveRate();
    const totalHoyUSD = aprobados
      .filter((p) => (p.resolvedAtMs || p.createdAtMs) >= hoyMs)
      .reduce((acc, p) => acc + p.montoUSD, 0);

    const vencimientos = computeVencimientos(data);
    const vencidas = vencimientos.filter((v) => v.vencida).length;
    const porVencer = vencimientos.filter((v) => !v.vencida).length;

    const total = currentConfig.totalNumeros;
    let vendidos = 0;
    let reservados = 0;
    let espera = 0;
    Object.values(data.tickets).forEach((t) => {
      if (t.estatus === 'PAGADO') vendidos++;
      else if (t.estatus === 'RESERVADO') reservados++;
      else if (t.estatus === 'ESPERA') espera++;
    });
    const disponibles = Math.max(0, total - vendidos - reservados - espera);

    let html = '<div class="bg-emerald-50 border border-emerald-200 rounded-xl p-3.5">';
    html += '<div class="text-[10px] font-black text-emerald-700 uppercase mb-1">💰 Ingresos Aprobados</div>';
    html += `<div class="text-2xl font-black text-emerald-900 font-mono">$${fmt(totalUSD)}</div>`;
    html += `<div class="text-xs text-emerald-700 font-mono">≈ Bs ${fmt(totalBs)}</div>`;
    html += '<div class="grid grid-cols-3 gap-2 mt-2.5 pt-2.5 border-t border-emerald-200 text-center">';
    html += `<div><div class="text-[10px] font-bold text-emerald-600">HOY</div><b class="text-xs font-mono">$${fmt(totalHoyUSD)}</b></div>`;
    html += `<div><div class="text-[10px] font-bold text-emerald-600">APROBADOS</div><b class="text-xs font-mono">${aprobados.length}</b></div>`;
    html += `<div><div class="text-[10px] font-bold text-emerald-600">X VENCER</div><b class="text-xs font-mono text-amber-700">${porVencer}</b></div>`;
    html += '</div>';
    if (vencidas > 0) {
      html += `<div class="mt-2 bg-rose-100 text-rose-700 text-xs font-black py-1.5 px-2.5 rounded-lg">⚠️ ${vencidas} reserva(s) vencida(s)</div>`;
    }
    html += '</div>';

    html += '<div class="subcard border-amber-200 bg-amber-50/70 text-xs">';
    html += '<b class="block mb-1.5 text-slate-900">📊 Estado de Taquilla</b>';
    html += '<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">';
    html += `<div>🟢 Libres: <b>${disponibles}</b></div>`;
    html += `<div>🔵 Reservas: <b>${reservados}</b></div>`;
    html += `<div>🟣 Revisión: <b>${espera}</b></div>`;
    html += `<div>🔴 Vendidos: <b>${vendidos}</b></div>`;
    html += '</div></div>';

    html += '<div class="grid grid-cols-3 gap-2">';
    html += '<button type="button" data-admin-action="resinc" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded-lg text-xs transition">🔄 Re-sinc</button>';
    html += '<button type="button" data-admin-action="liberar-masivo" class="bg-amber-600 hover:bg-amber-700 text-white font-bold py-2 rounded-lg text-xs transition">🔓 Liberar</button>';
    html += '<button type="button" data-admin-action="csv" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2 rounded-lg text-xs transition">📥 CSV</button>';
    html += '</div>';

    html += '<div class="space-y-2.5">';
    if (!pendientes.length) {
      html += '<div class="subcard text-center text-slate-500 py-5 text-xs">No hay pagos pendientes por validar 🎉</div>';
    } else {
      for (const p of pendientes) {
        html += '<div class="subcard space-y-1.5">';
        html += '<div class="flex justify-between items-start gap-2">';
        html += `<div><b class="text-xs sm:text-sm text-slate-900">${escHtml(p.nombre)}</b><br><span class="text-[11px] text-slate-500 font-mono">C.I. ${escHtml(p.cedula)}</span></div>`;
        html += `<div class="text-right"><b class="text-sm text-emerald-600 font-mono">$${fmt(p.montoUSD)}</b><br><span class="text-[10px] text-slate-500">${escHtml(formatDateTime(p.createdAtMs))}</span></div></div>`;
        html += `<div class="text-xs text-blue-600 font-mono font-bold">🎟️ #${escHtml(p.numeros.join(', #'))}</div>`;
        html += `<div class="text-xs text-slate-700">Ref: <b>${escHtml(p.referencia)}</b> · ${escHtml(p.metodo)}</div>`;
        if (p.telefono) html += `<div class="text-[11px] text-slate-500"><i class="fa-solid fa-phone mr-1"></i>${escHtml(p.telefono)}</div>`;
        if (p.correo) html += `<div class="text-[11px] text-slate-500"><i class="fa-solid fa-envelope mr-1"></i>${escHtml(p.correo)}</div>`;
        if (p.comprobante && p.comprobante.startsWith('data:image')) {
          html += `<button type="button" data-view-receipt="${escHtml(p.id)}" class="w-full bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-700 py-1.5 rounded-lg text-xs font-bold transition">📎 Ver comprobante</button>`;
        }
        html += '<div class="flex gap-2 pt-1">';
        html += `<button type="button" data-resolve-id="${escHtml(p.id)}" data-resolve-acc="APROBADO" class="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2 rounded-lg text-xs transition">✓ Aprobar</button>`;
        html += `<button type="button" data-resolve-id="${escHtml(p.id)}" data-resolve-acc="RECHAZADO" class="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-bold py-2 rounded-lg text-xs transition">✗ Rechazar</button>`;
        html += '</div></div>';
      }
    }
    html += '</div>';
    cont.innerHTML = html;
  } catch (e) {
    cont.innerHTML = `<div class="rounded-xl bg-rose-50 border border-rose-200 p-3 text-center text-rose-700 text-xs font-semibold">${escHtml(formatErrorMessage(e, 'admin'))}</div>`;
  }
}

async function resolverPago(reportId: string, accion: 'APROBADO' | 'RECHAZADO', btn: HTMLButtonElement): Promise<void> {
  if (!exigirSesionAdminEnPanel()) return;
  const report = adminDataCache?.payments.find((p) => p.id === reportId);
  if (!report) return;

  const ejecutar = async () => {
    setBtnLoading(btn, true, '...');
    try {
      await resolvePaymentInFirestore(report, accion);
      if (accion === 'APROBADO') {
        notificar('✅ Pago aprobado y boletos marcados como PAGADO', 'success');
        abrirModalWAConDatos(report);
      } else {
        notificar('❌ Pago rechazado. Los boletos volvieron a RESERVADO', 'success');
      }
      await cargarPagosPendientesAdmin();
    } catch (e) {
      notificar(formatErrorMessage(e, 'admin'), 'error');
    } finally {
      setBtnLoading(btn, false);
    }
  };

  if (accion === 'RECHAZADO') {
    mostrarConfirm(
      '¿Rechazar este pago?',
      `Los boletos <b>#${escHtml(report.numeros.join(', #'))}</b> volverán a estado <b>RESERVADO</b>.`,
      'fa-triangle-exclamation',
      (ok) => { if (ok) void ejecutar(); },
      true
    );
  } else {
    await ejecutar();
  }
}

function abrirModalWAConDatos(p: PaymentReportDoc): void {
  const nums = p.numeros.join(', #');
  waData = {
    nombre: p.nombre,
    numeros: nums,
    ref: p.referencia,
    monto: fmt(p.montoUSD),
  };
  const telEl = $<HTMLInputElement>('waTelefono');
  if (telEl) telEl.value = normalizeDigits(p.telefono);
  const msg = `¡Hola *${p.nombre}*! 🎉\n\n✅ Tu pago por *$${fmt(p.montoUSD)}* (Ref: *${p.referencia}*) ha sido *APROBADO*.\n\n🎟️ Números: *#${nums}*\n\n¡Mucha suerte en el sorteo! 🍀\n*Mega Rifas*`;
  const prev = $('waPreview');
  if (prev) prev.innerHTML = escHtml(msg).replace(/\*(.*?)\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  abrirModal('modalWA');
}

function enviarWAConfirmado(): void {
  const tel = normalizeDigits($<HTMLInputElement>('waTelefono')?.value || '');
  if (!tel) {
    notificar('Ingresa el teléfono WhatsApp', 'error');
    return;
  }
  if (!waData) return;
  const normalized = tel.length === 11 && tel.startsWith('0') ? `58${tel.slice(1)}` : tel;
  const msg = encodeURIComponent(
    `¡Hola *${waData.nombre}*! 🎉\n\n✅ Tu pago por *$${waData.monto}* (Ref: *${waData.ref}*) ha sido *APROBADO*.\n\n🎟️ Números: *#${waData.numeros}*\n\n¡Mucha suerte en el sorteo! 🍀\n*Mega Rifas*`
  );
  const a = document.createElement('a');
  a.href = `https://wa.me/${normalized}?text=${msg}`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.click();
  cerrarModal('modalWA');
  notificar('✅ WhatsApp abierto', 'success');
}

async function cargarPorVencerAdmin(): Promise<void> {
  if (!exigirSesionAdminEnPanel()) return;
  const cont = $('adminViewVnc');
  if (!cont) return;
  cont.innerHTML =
    '<div class="subcard text-center text-slate-500 py-4 text-xs"><i class="fa-solid fa-spinner fa-spin mr-1"></i> Cargando reservas...</div>';
  try {
    const data = await refrescarDatosAdmin();
    const lista = computeVencimientos(data);
    if (!lista.length) {
      cont.innerHTML =
        '<div class="subcard text-center text-slate-500 py-6 text-xs">🎉 No hay reservas por vencer ni vencidas.</div>';
      return;
    }
    let html = '<p class="text-xs text-slate-500 font-semibold">Reservas que vencen en ≤3 días o ya vencidas.</p>';
    for (const it of lista) {
      const urgente = it.vencida ? 'bg-rose-50 border-rose-300' : 'bg-amber-50 border-amber-300';
      const badge = it.vencida
        ? `<span class="text-[10px] font-black text-rose-700 bg-rose-200 px-2 py-0.5 rounded-full">⚠️ VENCIDA hace ${Math.abs(it.diasRestantes)}d</span>`
        : it.diasRestantes === 0
        ? '<span class="text-[10px] font-black text-rose-700 bg-rose-100 px-2 py-0.5 rounded-full">🔴 Vence HOY</span>'
        : `<span class="text-[10px] font-black text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">⏰ Vence en ${it.diasRestantes}d</span>`;
      const telRaw = normalizeDigits(it.telefono);
      const telWA = telRaw.length === 11 && telRaw.startsWith('0') ? `58${telRaw.slice(1)}` : telRaw;
      const numsTxt = it.numeros.join(', #');
      const msgWA = `¡Hola *${it.nombre}*! 👋\n\nTe recordamos que tienes boletos reservados en *Mega Rifas* 🎟️\n\n🎟️ Números: *#${numsTxt}*\n\n⏰ ${it.vencida ? 'Tu reserva está *vencida*. Urgente para no perder los números.' : 'Completa tu pago para no perder tus números.'}\n\n*Mega Rifas*`;

      html += `<div class="subcard border ${urgente} space-y-1.5">`;
      html += '<div class="flex justify-between items-start gap-2">';
      html += `<div><b class="text-xs sm:text-sm">${escHtml(it.nombre)}</b><br><span class="text-[11px] text-slate-500 font-mono">C.I. ${escHtml(it.cedula)}</span></div>${badge}</div>`;
      html += `<div class="text-xs text-blue-600 font-mono font-bold">🎟️ #${escHtml(numsTxt)}</div>`;
      if (it.telefono) html += `<div class="text-[11px] text-slate-600"><i class="fa-solid fa-phone mr-1"></i>${escHtml(it.telefono)}</div>`;
      if (it.correo) html += `<div class="text-[11px] text-slate-600"><i class="fa-solid fa-envelope mr-1"></i>${escHtml(it.correo)}</div>`;
      html += '<div class="flex gap-2 pt-1">';
      if (it.correo) {
        html += `<a href="mailto:${escHtml(it.correo)}?subject=${encodeURIComponent('Recordatorio - Mega Rifas')}&body=${encodeURIComponent(`Hola ${it.nombre},\n\nTe recordamos tus boletos reservados en Mega Rifas: #${numsTxt}\n\n— Mega Rifas`)}" class="flex-1 bg-blue-600 text-white font-bold py-2 rounded-lg text-xs text-center">📧 Correo</a>`;
      }
      if (telWA) {
        html += `<a href="https://wa.me/${telWA}?text=${encodeURIComponent(msgWA)}" target="_blank" rel="noopener noreferrer" class="flex-1 bg-emerald-600 text-white font-bold py-2 rounded-lg text-xs text-center">📱 WhatsApp</a>`;
      }
      html += '</div></div>';
    }
    cont.innerHTML = html;
  } catch (e) {
    cont.innerHTML = `<div class="rounded-xl bg-rose-50 border border-rose-200 p-3 text-center text-rose-700 text-xs font-semibold">${escHtml(formatErrorMessage(e, 'admin'))}</div>`;
  }
}

async function cargarHistorialAdmin(): Promise<void> {
  if (!exigirSesionAdminEnPanel()) return;
  const cont = $('adminViewHis');
  if (!cont) return;
  cont.innerHTML =
    '<div class="subcard text-center text-slate-500 py-4 text-xs"><i class="fa-solid fa-spinner fa-spin mr-1"></i> Cargando historial...</div>';

  try {
    const data = await refrescarDatosAdmin();
    const filters: Array<'TODOS' | 'PAGADO' | 'ESPERA' | 'RESERVADO'> = ['TODOS', 'PAGADO', 'ESPERA', 'RESERVADO'];
    let html = '<div class="flex gap-1.5 mb-2 overflow-x-auto pb-1">';
    for (const f of filters) {
      const on = historialFiltro === f;
      html += `<button type="button" data-hist-filter="${f}" class="px-3 py-1.5 rounded-lg text-xs font-black ${on ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'} whitespace-nowrap">${f}</button>`;
    }
    html += '</div>';

    const lista = Object.values(data.tickets)
      .filter((t) => t.estatus !== 'DISPONIBLE' && (historialFiltro === 'TODOS' || t.estatus === historialFiltro))
      .sort((a, b) => a.numero.localeCompare(b.numero));

    if (!lista.length) {
      html += '<div class="subcard text-center text-slate-500 py-5 text-xs">Sin registros en este filtro.</div>';
      cont.innerHTML = html;
      return;
    }

    const colores: Record<string, string> = {
      PAGADO: 'bg-slate-50 text-slate-800 border-slate-300',
      ESPERA: 'bg-purple-50 text-purple-800 border-purple-200',
      RESERVADO: 'bg-blue-50 text-blue-800 border-blue-200',
    };

    for (const t of lista) {
      const c = data.contacts[t.numero];
      const cls = colores[t.estatus] || 'bg-slate-50 text-slate-700 border-slate-200';
      const nombre = c?.nombre || t.displayName || 'Participante';
      const cedula = c?.cedula || '—';
      const telefono = c?.telefono || '';
      const telDigits = normalizeDigits(telefono);
      const telWA = telDigits.length === 11 && telDigits.startsWith('0') ? `58${telDigits.slice(1)}` : telDigits;

      html += `<div class="subcard border ${cls} space-y-1">`;
      html += '<div class="flex justify-between items-start">';
      html += `<div><span class="text-lg font-black font-mono">#${escHtml(t.numero)}</span> <span class="text-[10px] font-black px-2 py-0.5 rounded-full border ${cls}">${escHtml(t.estatus)}</span></div>`;
      html += `<button type="button" data-edit-ticket="${escHtml(t.numero)}" class="text-xs font-black text-blue-600 hover:underline">✏️ Editar</button>`;
      html += '</div>';
      html += `<div class="text-xs text-slate-800 font-bold">${escHtml(nombre)}</div>`;
      html += `<div class="text-[11px] text-slate-500 font-mono">C.I. ${escHtml(cedula)}${telefono ? ` · ${escHtml(telefono)}` : ''}</div>`;
      if (t.reservedAtMs) html += `<div class="text-[10px] text-slate-500">Reservado: ${escHtml(formatDateTime(t.reservedAtMs))}</div>`;
      if (t.paidAtMs) html += `<div class="text-[10px] text-emerald-700 font-bold">Pagado: ${escHtml(formatDateTime(t.paidAtMs))}</div>`;

      const acciones: string[] = [];
      if (t.estatus === 'RESERVADO' && telWA) {
        const msg = encodeURIComponent(
          `¡Hola *${nombre}*! 👋\n\nTe recordamos que tienes el boleto *#${t.numero}* reservado en *Mega Rifas* 🎟️\n\n⏰ Completa tu pago antes del límite.\n\n*Mega Rifas*`
        );
        acciones.push(
          `<a href="https://wa.me/${telWA}?text=${msg}" target="_blank" rel="noopener noreferrer" class="flex-1 bg-emerald-600 text-white font-bold py-1.5 rounded-lg text-xs text-center">📱 Recordar</a>`
        );
      }
      acciones.push(
        `<button type="button" data-release-ticket="${escHtml(t.numero)}" class="flex-1 bg-amber-600 text-white font-bold py-1.5 rounded-lg text-xs">🔓 Liberar</button>`
      );
      html += `<div class="flex gap-2 pt-1.5">${acciones.join('')}</div></div>`;
    }
    cont.innerHTML = html;
  } catch (e) {
    cont.innerHTML = `<div class="rounded-xl bg-rose-50 border border-rose-200 p-3 text-center text-rose-700 text-xs font-semibold">${escHtml(formatErrorMessage(e, 'admin'))}</div>`;
  }
}

function abrirEditarTicket(numero: string): void {
  const t = adminDataCache?.tickets[numero];
  const c = adminDataCache?.contacts[numero];
  if (!t) return;
  const numEl = $<HTMLInputElement>('editNumero');
  const estEl = $<HTMLSelectElement>('editEstatus');
  const cedEl = $<HTMLInputElement>('editCedula');
  const nomEl = $<HTMLInputElement>('editNombre');
  const telEl = $<HTMLInputElement>('editTelefono');
  const corEl = $<HTMLInputElement>('editCorreo');
  const titEl = $('editTituloNum');

  if (titEl) titEl.textContent = `#${numero}`;
  if (numEl) numEl.value = numero;
  if (estEl) estEl.value = t.estatus;
  if (cedEl) cedEl.value = c?.cedula || '';
  if (nomEl) nomEl.value = c?.nombre || t.displayName || '';
  if (telEl) telEl.value = c?.telefono || '';
  if (corEl) corEl.value = c?.correo || '';
  abrirModal('modalEditar');
}

async function guardarEdicionTicket(): Promise<void> {
  if (!exigirSesionAdminEnPanel()) return;
  const numero = ($<HTMLInputElement>('editNumero')?.value || '').trim();
  const estatus = ($<HTMLSelectElement>('editEstatus')?.value || 'DISPONIBLE') as TicketStatus;
  const cedula = ($<HTMLInputElement>('editCedula')?.value || '').trim();
  const nombre = ($<HTMLInputElement>('editNombre')?.value || '').trim();
  const telefono = ($<HTMLInputElement>('editTelefono')?.value || '').trim();
  const correo = ($<HTMLInputElement>('editCorreo')?.value || '').trim();
  if (!numero) return;

  const btn = $<HTMLButtonElement>('btnGuardarEdicion');
  setBtnLoading(btn, true, 'Guardando...');
  try {
    await editTicketInFirestore({ numero, estatus, cedula, nombre, telefono, correo });
    notificar(`✅ Boleto #${numero} actualizado`, 'success');
    cerrarModal('modalEditar');
    await cargarHistorialAdmin();
  } catch (e) {
    notificar(formatErrorMessage(e, 'admin'), 'error');
  } finally {
    setBtnLoading(btn, false);
  }
}

function confirmarLiberarTicket(numero: string): void {
  if (!exigirSesionAdminEnPanel()) return;
  mostrarConfirm(
    `¿Liberar #${numero}?`,
    `El boleto <b>#${escHtml(numero)}</b> volverá a estar <b>DISPONIBLE</b> para otros participantes.`,
    'fa-unlock',
    async (ok) => {
      if (!ok) return;
      try {
        await releaseSingleTicketInFirestore(numero);
        notificar(`✅ #${numero} liberado`, 'success');
        await cargarHistorialAdmin();
      } catch (e) {
        notificar(formatErrorMessage(e, 'admin'), 'error');
      }
    },
    true
  );
}

function ejecutarResincronizar(): void {
  if (!exigirSesionAdminEnPanel()) return;
  mostrarConfirm(
    '¿Resincronizar tablero?',
    'Revisa todos los reportes de pago aprobados y pendientes para garantizar que el tablero esté 100% alineado.',
    'fa-rotate',
    async (ok) => {
      if (!ok) return;
      notificar('Resincronizando...', 'info');
      try {
        const cambios = await resyncBoardInFirestore();
        notificar(`✅ Resincronización lista (${cambios} ajuste(s))`, 'success');
        await cargarPagosPendientesAdmin();
      } catch (e) {
        notificar(formatErrorMessage(e, 'admin'), 'error');
      }
    }
  );
}

function ejecutarLiberarMasivo(): void {
  if (!exigirSesionAdminEnPanel()) return;
  mostrarConfirm(
    '¿Liberar todas las reservas?',
    'Todos los números en estado <b>RESERVADO</b> volverán a estar <b>DISPONIBLES</b>. Los boletos en revisión o pagados NO se tocan.',
    'fa-triangle-exclamation',
    async (ok) => {
      if (!ok) return;
      notificar('Liberando reservas...', 'info');
      try {
        const liberados = await releaseAllReservedInFirestore();
        notificar(`✅ ${liberados} número(s) liberado(s)`, 'success');
        await cargarPagosPendientesAdmin();
      } catch (e) {
        notificar(formatErrorMessage(e, 'admin'), 'error');
      }
    },
    true
  );
}

async function exportarCSVAdmin(): Promise<void> {
  if (!exigirSesionAdminEnPanel()) return;
  try {
    const data = adminDataCache || (await refrescarDatosAdmin());
    const rows: string[][] = [
      ['Numero', 'Estatus', 'Cedula', 'Nombre', 'Telefono', 'Correo', 'Fecha Reserva', 'Fecha Pago'],
    ];
    const total = currentConfig.totalNumeros;
    const dig = total >= 1000 ? 3 : 2;
    for (let i = 0; i < total; i++) {
      const num = String(i).padStart(dig, '0');
      const t = data.tickets[num];
      if (!t || t.estatus === 'DISPONIBLE') continue;
      const c = data.contacts[num];
      rows.push([
        num,
        t.estatus,
        c?.cedula || '',
        c?.nombre || t.displayName || '',
        c?.telefono || '',
        c?.correo || '',
        formatDateTime(t.reservedAtMs),
        formatDateTime(t.paidAtMs),
      ]);
    }
    const csv = rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mega-rifas-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notificar('✅ CSV descargado', 'success');
  } catch (e) {
    notificar(formatErrorMessage(e, 'admin'), 'error');
  }
}

/* ==================== CONFIGURACIÓN ADMIN (FIRESTORE) ==================== */

function ocultarFeedbackConfig(): void {
  const box = $('cfgSaveFeedback');
  if (!box) return;
  box.classList.add('hidden');
  box.innerHTML = '';
}

function mostrarFeedbackConfig(tipo: 'success' | 'error', html: string): void {
  const box = $('cfgSaveFeedback');
  if (!box) return;
  box.className = `rounded-xl p-3 text-xs font-semibold border ${
    tipo === 'success'
      ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
      : 'bg-rose-50 border-rose-300 text-rose-900'
  }`;
  box.innerHTML = html;
  box.classList.remove('hidden');
}

function cargarFormularioConfigAdmin(): void {
  const c = currentConfig;
  const setVal = (id: string, v: string) => {
    const el = $<HTMLInputElement | HTMLTextAreaElement>(id);
    if (el) el.value = v;
  };
  setVal('cfgTitulo', c.tituloRifa);
  setVal('cfgTotal', String(c.totalNumeros));
  setVal('cfgPrecio', String(c.precioTicketUSD));
  setVal('cfgPremios', c.premios);
  setVal('cfgNoticias', c.noticias);
  setVal('cfgTickerNoticias', c.tickerNoticias);
  setVal('cfgTasaManual', c.tasaManual > 0 ? String(c.tasaManual) : '');
  setVal('cfgFechaSorteo', c.fechaSorteo);
  setVal('cfgDiasPago', String(c.diasLimitePago));
  setVal('cfgDiasBloqueo', String(c.diasBloqueo));
  setVal('cfgPM', c.pmDatos);
  setVal('cfgTR', c.trDatos);
  setVal('cfgBZ', c.binanceDatos);
  setVal('cfgZP', c.zelleDatos);
  setVal('cfgEF', c.efectivoDatos);
  setVal('cfgUS', c.usdtDatos);
  setVal('cfgIG', c.igUrl);
  setVal('cfgWA1', c.waList[0] || '');
  setVal('cfgWA2', c.waList[1] || '');
  setVal('cfgWA3', c.waList[2] || '');

  const bcvHint = $('cfgBcvHint');
  if (bcvHint) {
    const rate = liveBcvRate || c.tasa;
    bcvHint.textContent = rate > 0 ? `Tasa BCV actual: Bs ${fmt(rate)}` : 'Vacío = tasa BCV automática';
  }
  cfgDirty = false;
}

async function guardarConfigAdmin(): Promise<void> {
  if (!exigirSesionAdminEnPanel()) return;
  ocultarFeedbackConfig();
  const getVal = (id: string) => ($<HTMLInputElement | HTMLTextAreaElement>(id)?.value || '').trim();

  const totalNumeros = parseInt(getVal('cfgTotal'), 10);
  const precioTicketUSD = parseLocaleNumber(getVal('cfgPrecio'));
  const tasaManualRaw = getVal('cfgTasaManual');
  const tasaManual = tasaManualRaw ? parseLocaleNumber(tasaManualRaw) : 0;
  const diasLimitePago = parseInt(getVal('cfgDiasPago'), 10);
  const diasBloqueo = parseInt(getVal('cfgDiasBloqueo'), 10);

  const errores: string[] = [];
  if (!isFinite(totalNumeros) || totalNumeros < 1 || totalNumeros > 1000) {
    errores.push('Total Números debe estar entre 1 y 1000.');
  }
  if (!isFinite(precioTicketUSD) || precioTicketUSD <= 0) {
    errores.push('Precio ($) debe ser mayor a 0.');
  }
  if (tasaManualRaw && (!isFinite(tasaManual) || tasaManual < 0)) {
    errores.push('Tasa Manual debe ser un número válido o quedar vacía.');
  }
  if (!isFinite(diasLimitePago) || diasLimitePago < 1 || diasLimitePago > 365) {
    errores.push('Días p/ pagar debe estar entre 1 y 365.');
  }
  if (!isFinite(diasBloqueo) || diasBloqueo < 0 || diasBloqueo > 365) {
    errores.push('Días bloqueo reservas debe estar entre 0 y 365.');
  }

  if (errores.length) {
    mostrarFeedbackConfig('error', `<b>Revisa estos datos:</b><br>• ${errores.map(escHtml).join('<br>• ')}`);
    notificar(errores[0], 'error');
    return;
  }

  const waList = [getVal('cfgWA1'), getVal('cfgWA2'), getVal('cfgWA3')]
    .map(normalizeDigits)
    .filter(Boolean)
    .slice(0, 3);

  const nextConfig: RaffleConfigData = {
    tituloRifa: getVal('cfgTitulo'),
    totalNumeros,
    precioTicketUSD,
    tasa: tasaManual > 0 ? tasaManual : (liveBcvRate || currentConfig.tasa || 0),
    tasaManual: tasaManual > 0 ? tasaManual : 0,
    premios: getVal('cfgPremios'),
    noticias: getVal('cfgNoticias'),
    tickerNoticias: getVal('cfgTickerNoticias'),
    fechaSorteo: getVal('cfgFechaSorteo'),
    diasLimitePago,
    diasBloqueo,
    pmDatos: getVal('cfgPM'),
    trDatos: getVal('cfgTR'),
    binanceDatos: getVal('cfgBZ'),
    zelleDatos: getVal('cfgZP'),
    efectivoDatos: getVal('cfgEF'),
    usdtDatos: getVal('cfgUS'),
    igUrl: getVal('cfgIG'),
    waList,
  };

  const btn = $<HTMLButtonElement>('btnGuardarConfig');
  setBtnLoading(btn, true, 'Guardando en Firebase...');

  try {
    const saved = await saveRaffleConfigInFirestore(nextConfig);
    currentConfig = saved;
    configExistsInDb = true;
    cfgDirty = false;
    guardarCacheLocal();
    renderAll();
    cargarFormularioConfigAdmin();
    mostrarFeedbackConfig(
      'success',
      `✅ Todos los cambios se guardaron y verificaron en Firebase. Boleto actual: <b>$${fmt(saved.precioTicketUSD)}</b> → <b>Bs ${fmt(getTicketPriceBs())}</b>.`
    );
    notificar('✅ Configuración guardada en Firebase', 'success');
  } catch (e) {
    const msg = formatErrorMessage(e, 'admin');
    mostrarFeedbackConfig('error', `<b>No se pudo guardar:</b> ${escHtml(msg)}`);
    notificar(msg, 'error');
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ==================== RESET RIFA ==================== */

function ejecutarNuevaRifa(): void {
  if (!exigirSesionAdminEnPanel()) return;
  const confirmText = ($<HTMLInputElement>('inputConfirmReset')?.value || '').trim().toUpperCase();
  if (confirmText !== 'REINICIAR') {
    notificar('Escribe REINICIAR para confirmar', 'error');
    return;
  }
  mostrarConfirm(
    '⚠️ Reiniciar TODA la rifa',
    'Esto borrará <b>TODOS</b> los boletos vendidos/reservados y <b>TODOS</b> los reportes de pago en Firebase. <b>No se puede deshacer.</b>',
    'fa-triangle-exclamation',
    async (ok) => {
      if (!ok) return;
      const btn = $<HTMLButtonElement>('btnReiniciarRifa');
      setBtnLoading(btn, true, 'Reiniciando...');
      try {
        await resetRaffleInFirestore();
        seleccionados = [];
        participanteConsultado = null;
        $('resultadoConsultaParticipante')?.classList.add('hidden');
        const inp = $<HTMLInputElement>('inputConfirmReset');
        if (inp) inp.value = '';
        notificar('✅ Rifa reiniciada por completo', 'success');
        cerrarModal('modalPanelAdmin');
      } catch (e) {
        notificar(formatErrorMessage(e, 'admin'), 'error');
      } finally {
        setBtnLoading(btn, false);
      }
    },
    true
  );
}

/* ==================== BOOTSTRAP & EVENT WIRING ==================== */

function renderizarSkeletonTablero(): void {
  const grid = $('gridTablero');
  if (!grid || grid.children.length > 0) return;
  grid.innerHTML = Array.from({ length: 50 }, () => '<div class="num-btn skeleton" aria-hidden="true"></div>').join('');
}

function wireEvents(): void {
  // Board click delegation (O(1))
  $('gridTablero')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-num]');
    if (!btn) return;
    tocarNumero(btn.dataset.num || '', btn.dataset.est || 'DISPONIBLE');
  });

  // Lookup result click delegation
  $('resultadoConsultaParticipante')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const chip = target.closest<HTMLElement>('[data-toggle-res]');
    if (chip) {
      toggleReservado(chip.dataset.toggleRes || '');
      return;
    }
    const actionBtn = target.closest<HTMLElement>('[data-action]');
    if (!actionBtn) return;
    if (actionBtn.dataset.action === 'sel-todos-res') seleccionarTodosReservados();
    if (actionBtn.dataset.action === 'pagar-res') pagarReservadosSeleccionados();
  });

  // Admin Pagos & Hist click delegation
  $('adminViewVal')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const receiptBtn = target.closest<HTMLElement>('[data-view-receipt]');
    if (receiptBtn) {
      const report = adminDataCache?.payments.find((p) => p.id === receiptBtn.dataset.viewReceipt);
      if (report?.comprobante) {
        const img = $<HTMLImageElement>('imgComprobante');
        if (img) img.src = report.comprobante;
        abrirModal('modalImagen');
      }
      return;
    }
    const resolveBtn = target.closest<HTMLButtonElement>('[data-resolve-id]');
    if (resolveBtn) {
      const id = resolveBtn.dataset.resolveId || '';
      const acc = resolveBtn.dataset.resolveAcc as 'APROBADO' | 'RECHAZADO';
      void resolverPago(id, acc, resolveBtn);
      return;
    }
    const admAct = target.closest<HTMLElement>('[data-admin-action]');
    if (admAct) {
      const act = admAct.dataset.adminAction;
      if (act === 'resinc') ejecutarResincronizar();
      if (act === 'liberar-masivo') ejecutarLiberarMasivo();
      if (act === 'csv') void exportarCSVAdmin();
    }
  });

  $('adminViewHis')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const filterBtn = target.closest<HTMLElement>('[data-hist-filter]');
    if (filterBtn) {
      historialFiltro = (filterBtn.dataset.histFilter || 'TODOS') as typeof historialFiltro;
      void cargarHistorialAdmin();
      return;
    }
    const editBtn = target.closest<HTMLElement>('[data-edit-ticket]');
    if (editBtn) {
      abrirEditarTicket(editBtn.dataset.editTicket || '');
      return;
    }
    const relBtn = target.closest<HTMLElement>('[data-release-ticket]');
    if (relBtn) {
      confirmarLiberarTicket(relBtn.dataset.releaseTicket || '');
    }
  });

  // Static buttons
  $('btnConsultarCedula')?.addEventListener('click', () => void consultarParticipante());
  $('inputCedulaConsulta')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void consultarParticipante();
  });
  $('btnAzar')?.addEventListener('click', seleccionarAzar);
  $('btnLimpiarSel')?.addEventListener('click', limpiarSeleccion);
  $('btnStickyContinuar')?.addEventListener('click', () => abrirModalCheckout('PAGAR'));
  $('btnReservarFlotante')?.addEventListener('click', () => abrirModalCheckout('RESERVADO'));
  $('btnPagarFlotante')?.addEventListener('click', () => abrirModalCheckout('PAGAR'));
  $('btnEjecutarCheckout')?.addEventListener('click', () => void ejecutarCheckout());

  (['PM', 'TR', 'BZ', 'ZP', 'EF', 'US'] as PaymentMethodCode[]).forEach((code) => {
    $(`pm${code}`)?.addEventListener('click', () => cambiarMetodoPago(code));
  });

  $('btnAbrirAdmin')?.addEventListener('click', () => void abrirModalAdminSeguro());
  $('btnLoginGoogleAdmin')?.addEventListener('click', () => void iniciarSesionAdminGoogle());
  $('btnLogoutAdmin')?.addEventListener('click', () => void cerrarSesionAdmin());
  $('btnGuardarConfig')?.addEventListener('click', () => void guardarConfigAdmin());
  $('btnRecargarConfig')?.addEventListener('click', () => {
    cfgDirty = false;
    cargarFormularioConfigAdmin();
    notificar('Valores sincronizados desde Firebase', 'info');
  });
  $('btnReiniciarRifa')?.addEventListener('click', ejecutarNuevaRifa);
  $('btnGuardarEdicion')?.addEventListener('click', () => void guardarEdicionTicket());
  $('btnEnviarWA')?.addEventListener('click', enviarWAConfirmado);

  $('confirmBtnCancel')?.addEventListener('click', () => cerrarConfirm(false));
  $('confirmBtnOk')?.addEventListener('click', () => cerrarConfirm(true));

  (['val', 'vnc', 'his', 'cfg', 'nue'] as const).forEach((tab) => {
    const map = { val: 'adminTabVal', vnc: 'adminTabVnc', his: 'adminTabHis', cfg: 'adminTabCfg', nue: 'adminTabNue' };
    $(map[tab])?.addEventListener('click', () => cambiarTabAdmin(tab));
  });

  document.querySelectorAll<HTMLElement>('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', () => cerrarModal(el.dataset.closeModal || ''));
  });

  $('modalImagen')?.addEventListener('click', (e) => {
    if (e.target === $('modalImagen')) cerrarModal('modalImagen');
  });

  $('adminViewCfg')?.addEventListener('input', () => { cfgDirty = true; });
  $('adminViewCfg')?.addEventListener('change', () => { cfgDirty = true; });

  // Input digit guards
  $('chkCedula')?.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    el.value = normalizeDigits(el.value);
  });
  $('chkReferencia')?.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    el.value = normalizeDigits(el.value).slice(0, 4);
  });
  $('waTelefono')?.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    el.value = normalizeDigits(el.value);
  });
}

function initApp(): void {
  wireEvents();
  void testConnection();

  // 1) Instant 0ms paint from localStorage cache (or board skeleton on first visit)
  const cached = leerCacheLocal();
  if (cached) {
    currentConfig = cached.config;
    currentTickets = cached.tickets;
    renderAll();
  } else {
    renderizarSkeletonTablero();
  }

  // 2) Background BCV rate check
  void fetchLiveBcvRate().then((rate) => {
    if (rate && rate > 0) {
      liveBcvRate = rate;
      renderAll();
    }
  });

  // 3) Public-only Firestore realtime listeners (silent fallback on transient/auth issues)
  subscribeRaffleConfig(
    (config, exists) => {
      configExistsInDb = exists;
      currentConfig = config;
      guardarCacheLocal();
      renderAll();
    },
    (err) => {
      console.warn('Public raffleConfig sync fallback:', err.message);
      renderAll();
    }
  );

  subscribeTickets(
    (tickets) => {
      currentTickets = tickets;
      guardarCacheLocal();
      renderAll();
    },
    (err) => {
      console.warn('Public tickets sync fallback:', err.message);
      renderAll();
    }
  );

  // 4) Observe Firebase Auth passively (never run Admin DB queries on public load)
  observeAuth((user) => {
    currentAdminUser = user;
    if (!user) {
      isCurrentUserAdmin = false;
      adminDataCache = null;
      return;
    }
    const isBootstrap =
      user.emailVerified &&
      (user.email || '').toLowerCase() === ADMIN_BOOTSTRAP_EMAIL.toLowerCase();
    isCurrentUserAdmin = isBootstrap;
    if (isBootstrap) {
      const badge = $('adminEmailBadge');
      if (badge && user.email) badge.textContent = user.email;
    }
  });
}

document.addEventListener('DOMContentLoaded', initApp);
