import emailjs from '@emailjs/browser';
import {
  normalizeAdminEmails,
  type PaymentMethodLabel,
  type PaymentReportDoc,
  type RaffleConfigData,
} from './raffleService';

function fmtMoney(n: number): string {
  if (!isFinite(n)) return '0,00';
  const p = n.toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return p.join(',');
}

function isEmailJsReady(config: RaffleConfigData, templateId: string): boolean {
  return Boolean(
    config.emailjsEnabled &&
      config.emailjsServiceId.trim() &&
      config.emailjsPublicKey.trim() &&
      templateId.trim()
  );
}

export interface PurchaseEmailPayload {
  nombre: string;
  cedula: string;
  telefono: string;
  correo: string;
  numeros: string[];
  montoUSD: number;
  montoBs: number;
  metodo: PaymentMethodLabel;
  referencia: string;
}

/**
 * Sends purchase confirmation to the buyer and pending-payment alert to all authorized admins.
 * Never throws or blocks Firestore persistence.
 */
export async function sendPurchaseEmails(
  config: RaffleConfigData,
  payload: PurchaseEmailPayload
): Promise<void> {
  const templateId = config.emailjsTemplateCompra.trim();
  if (!isEmailJsReady(config, templateId)) {
    console.info('[EmailJS] Envío omitido: EmailJS no está activado o falta configurar credenciales.');
    return;
  }

  const serviceId = config.emailjsServiceId.trim();
  const publicKey = config.emailjsPublicKey.trim();
  const rifaTitulo = config.tituloRifa || 'Mega Rifas';
  const numerosTxt = payload.numeros.map((n) => `#${n}`).join(', ');
  const montoUsdTxt = `$${fmtMoney(payload.montoUSD)}`;
  const montoBsTxt = `Bs ${fmtMoney(payload.montoBs)}`;

  const baseParams = {
    rifa_titulo: rifaTitulo,
    comprador_nombre: payload.nombre,
    comprador_cedula: payload.cedula,
    comprador_telefono: payload.telefono,
    comprador_correo: payload.correo,
    numeros: numerosTxt,
    cantidad_boletos: String(payload.numeros.length),
    monto_usd: montoUsdTxt,
    monto_bs: montoBsTxt,
    metodo: payload.metodo,
    referencia: payload.referencia,
  };

  const tasks: Promise<unknown>[] = [];

  // 1) Confirmation email to buyer
  if (payload.correo.trim()) {
    tasks.push(
      emailjs
        .send(
          serviceId,
          templateId,
          {
            ...baseParams,
            to_email: payload.correo.trim(),
            to_name: payload.nombre,
            tipo_aviso: 'Confirmación de compra (En revisión)',
            estatus: 'En revisión',
            mensaje: `Hola ${payload.nombre}, recibimos tu reporte de pago por ${montoUsdTxt} (${montoBsTxt}) con referencia ${payload.referencia}. Tus números (${numerosTxt}) quedaron en estado En revisión y te avisaremos apenas sean aprobados.`,
          },
          { publicKey }
        )
        .catch((err) => {
          console.warn('[EmailJS] Error enviando confirmación al comprador:', err);
        })
    );
  }

  // 2) Alert email to all authorized admins
  const admins = normalizeAdminEmails(config.adminEmails);
  for (const adminEmail of admins) {
    tasks.push(
      emailjs
        .send(
          serviceId,
          templateId,
          {
            ...baseParams,
            to_email: adminEmail,
            to_name: 'Administrador Mega Rifas',
            tipo_aviso: 'Nuevo pago pendiente por validar',
            estatus: 'PENDIENTE',
            mensaje: `Nuevo pago pendiente en ${rifaTitulo}: ${payload.nombre} (C.I. ${payload.cedula}) reportó ${payload.numeros.length} boleto(s) (${numerosTxt}) por ${montoUsdTxt} (${montoBsTxt}) vía ${payload.metodo}, Ref: ${payload.referencia}.`,
          },
          { publicKey }
        )
        .catch((err) => {
          console.warn(`[EmailJS] Error enviando alerta al admin ${adminEmail}:`, err);
        })
    );
  }

  try {
    await Promise.allSettled(tasks);
  } catch (err) {
    console.warn('[EmailJS] Error inesperado enviando correos de compra:', err);
  }
}

/**
 * Sends payment approval confirmation email to the buyer.
 * Never throws or blocks Firestore persistence.
 */
export async function sendApprovalEmail(
  config: RaffleConfigData,
  report: PaymentReportDoc
): Promise<void> {
  const templateId = config.emailjsTemplateAprobacion.trim();
  if (!isEmailJsReady(config, templateId)) {
    console.info('[EmailJS] Envío de aprobación omitido: EmailJS no está activado o falta plantilla.');
    return;
  }
  if (!report.correo.trim()) {
    console.info('[EmailJS] Envío de aprobación omitido: el comprador no tiene correo registrado.');
    return;
  }

  const serviceId = config.emailjsServiceId.trim();
  const publicKey = config.emailjsPublicKey.trim();
  const rifaTitulo = config.tituloRifa || 'Mega Rifas';
  const numerosTxt = report.numeros.map((n) => `#${n}`).join(', ');
  const montoUsdTxt = `$${fmtMoney(report.montoUSD)}`;
  const montoBsTxt = `Bs ${fmtMoney(report.montoBs)}`;

  try {
    await emailjs.send(
      serviceId,
      templateId,
      {
        to_email: report.correo.trim(),
        to_name: report.nombre,
        tipo_aviso: 'Pago Aprobado',
        rifa_titulo: rifaTitulo,
        comprador_nombre: report.nombre,
        comprador_cedula: report.cedula,
        comprador_telefono: report.telefono,
        comprador_correo: report.correo,
        numeros: numerosTxt,
        cantidad_boletos: String(report.numeros.length),
        monto_usd: montoUsdTxt,
        monto_bs: montoBsTxt,
        metodo: report.metodo,
        referencia: report.referencia,
        estatus: 'APROBADO',
        mensaje: `¡Felicidades ${report.nombre}! Tu pago por ${montoUsdTxt} (Ref: ${report.referencia}) fue APROBADO. Tus boletos (${numerosTxt}) ya participan oficialmente en ${rifaTitulo}. ¡Mucha suerte!`,
      },
      { publicKey }
    );
  } catch (err) {
    console.warn('[EmailJS] Error enviando correo de aprobación al comprador:', err);
  }
}
