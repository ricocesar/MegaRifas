import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  getPaymentFrozenBs,
  type PaymentReportDoc,
  type RaffleConfigData,
  type TicketContactDoc,
  type TicketDoc,
} from './raffleService';

function fmtAmount(n: number): string {
  if (!isFinite(n)) return '0,00';
  const p = n.toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return p.join(',');
}

function fmtDateTime(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function addPdfHeader(
  pdf: jsPDF,
  title: string,
  subtitle: string,
  metaRight: string
): void {
  const pageWidth = pdf.internal.pageSize.getWidth();
  pdf.setFillColor(15, 23, 42); // slate-900
  pdf.rect(0, 0, pageWidth, 26, 'F');

  pdf.setFillColor(245, 158, 11); // amber-500 accent strip
  pdf.rect(0, 26, pageWidth, 1.8, 'F');

  pdf.setTextColor(255, 255, 255);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.text(title, 14, 11.5);

  pdf.setTextColor(251, 191, 36);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9.5);
  pdf.text(subtitle, 14, 19);

  pdf.setTextColor(203, 213, 225);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.text(metaRight, pageWidth - 14, 19, { align: 'right' });
}

function addPageFooters(pdf: jsPDF, label: string): void {
  const totalPages = pdf.getNumberOfPages();
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    pdf.setDrawColor(226, 232, 240);
    pdf.line(14, pageHeight - 12, pageWidth - 14, pageHeight - 12);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(100, 116, 139);
    pdf.text(`Mega Rifas · ${label}`, 14, pageHeight - 7);
    pdf.text(`Página ${i} de ${totalPages}`, pageWidth - 14, pageHeight - 7, { align: 'right' });
  }
}

export function exportPaymentsToPdf(params: {
  payments: PaymentReportDoc[];
  config: RaffleConfigData;
  effectiveRate: number;
}): void {
  const { payments, config, effectiveRate } = params;
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const nowStr = fmtDateTime(Date.now());
  const raffleTitle = config.tituloRifa ? `Rifa: ${config.tituloRifa}` : 'Rifa Activa';

  addPdfHeader(pdf, 'MEGA RIFAS · REPORTE DE PAGOS', raffleTitle, `Generado: ${nowStr}`);

  const aprobados = payments.filter((p) => p.estatus === 'APROBADO');
  const pendientes = payments.filter((p) => p.estatus === 'PENDIENTE');
  const rechazados = payments.filter((p) => p.estatus === 'RECHAZADO');
  const totalUSD = aprobados.reduce((acc, p) => acc + p.montoUSD, 0);
  const totalBs = aprobados.reduce((acc, p) => acc + getPaymentFrozenBs(p, effectiveRate), 0);

  // Summary strip
  const pageWidth = pdf.internal.pageSize.getWidth();
  pdf.setFillColor(248, 250, 252);
  pdf.setDrawColor(226, 232, 240);
  pdf.roundedRect(14, 32, pageWidth - 28, 16, 2, 2, 'FD');

  const cols = [
    { label: 'TOTAL RECAUDADO (Bs)', val: `Bs ${fmtAmount(totalBs)}` },
    { label: 'TOTAL RECAUDADO ($)', val: `$${fmtAmount(totalUSD)}` },
    { label: 'APROBADOS', val: String(aprobados.length) },
    { label: 'PENDIENTES', val: String(pendientes.length) },
    { label: 'RECHAZADOS', val: String(rechazados.length) },
  ];

  const colPositions = [18, 92, 152, 198, 242];
  cols.forEach((c, idx) => {
    const x = colPositions[idx];
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7);
    pdf.setTextColor(100, 116, 139);
    pdf.text(c.label, x, 37.5);
    pdf.setFontSize(10);
    pdf.setTextColor(15, 23, 42);
    pdf.text(c.val, x, 44);
  });

  const rows = payments.map((p) => [
    fmtDateTime(p.createdAtMs),
    p.nombre,
    p.cedula,
    p.telefono || '—',
    p.numeros.map((n) => `#${n}`).join(', '),
    p.metodo,
    p.referencia,
    `Bs ${fmtAmount(getPaymentFrozenBs(p, effectiveRate))}`,
    `$${fmtAmount(p.montoUSD)}`,
    p.estatus,
  ]);

  autoTable(pdf, {
    startY: 53,
    head: [['Fecha', 'Participante', 'Cédula', 'Teléfono', 'Boletos', 'Método', 'Ref.', 'Monto Bs', 'Monto $', 'Estatus']],
    body: rows.length
      ? rows
      : [['—', 'No hay pagos registrados.', '—', '—', '—', '—', '—', '—', '—', '—']],
    theme: 'grid',
    styles: {
      fontSize: 7.8,
      cellPadding: 2.2,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.2,
      valign: 'middle',
    },
    headStyles: {
      fillColor: [15, 23, 42],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 7.8,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    columnStyles: {
      0: { cellWidth: 26 },
      2: { cellWidth: 20 },
      3: { cellWidth: 26 },
      4: { cellWidth: 38 },
      5: { cellWidth: 22 },
      6: { cellWidth: 17 },
      7: { cellWidth: 28, halign: 'right', fontStyle: 'bold' },
      8: { cellWidth: 20, halign: 'right', fontStyle: 'bold' },
      9: { cellWidth: 22, halign: 'center', fontStyle: 'bold' },
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 9) {
        const val = String(data.cell.raw || '');
        if (val === 'APROBADO') {
          data.cell.styles.textColor = [4, 120, 87];
          data.cell.styles.fillColor = [236, 253, 245];
        } else if (val === 'PENDIENTE') {
          data.cell.styles.textColor = [180, 83, 9];
          data.cell.styles.fillColor = [255, 251, 235];
        } else if (val === 'RECHAZADO') {
          data.cell.styles.textColor = [190, 18, 60];
          data.cell.styles.fillColor = [255, 241, 242];
        }
      }
    },
    margin: { left: 14, right: 14, bottom: 18 },
  });

  addPageFooters(pdf, 'Reporte de Pagos');
  pdf.save(`mega-rifas-pagos-${new Date().toISOString().slice(0, 10)}.pdf`);
}

export function exportHistorialToPdf(params: {
  tickets: Record<string, TicketDoc>;
  contacts: Record<string, TicketContactDoc>;
  config: RaffleConfigData;
  filtro: 'TODOS' | 'PAGADO' | 'ESPERA' | 'RESERVADO';
}): void {
  const { tickets, contacts, config, filtro } = params;
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const nowStr = fmtDateTime(Date.now());
  const raffleTitle = `${config.tituloRifa ? `Rifa: ${config.tituloRifa} · ` : ''}Filtro: ${filtro}`;

  addPdfHeader(pdf, 'MEGA RIFAS · HISTORIAL DE BOLETOS', raffleTitle, `Generado: ${nowStr}`);

  const allActive = Object.values(tickets).filter((t) => t.estatus !== 'DISPONIBLE');
  const pagados = allActive.filter((t) => t.estatus === 'PAGADO').length;
  const espera = allActive.filter((t) => t.estatus === 'ESPERA').length;
  const reservados = allActive.filter((t) => t.estatus === 'RESERVADO').length;
  const libres = Math.max(0, config.totalNumeros - pagados - espera - reservados);

  const pageWidth = pdf.internal.pageSize.getWidth();
  pdf.setFillColor(248, 250, 252);
  pdf.setDrawColor(226, 232, 240);
  pdf.roundedRect(14, 32, pageWidth - 28, 16, 2, 2, 'FD');

  const summary = [
    { label: 'TOTAL BOLETOS', val: String(config.totalNumeros) },
    { label: 'PAGADOS', val: String(pagados) },
    { label: 'EN REVISIÓN', val: String(espera) },
    { label: 'RESERVADOS', val: String(reservados) },
    { label: 'DISPONIBLES', val: String(libres) },
  ];
  const colPositions = [18, 72, 126, 180, 234];
  summary.forEach((c, idx) => {
    const x = colPositions[idx];
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7);
    pdf.setTextColor(100, 116, 139);
    pdf.text(c.label, x, 37.5);
    pdf.setFontSize(10);
    pdf.setTextColor(15, 23, 42);
    pdf.text(c.val, x, 44);
  });

  const filtered = allActive
    .filter((t) => filtro === 'TODOS' || t.estatus === filtro)
    .sort((a, b) => a.numero.localeCompare(b.numero));

  const rows = filtered.map((t) => {
    const c = contacts[t.numero];
    return [
      `#${t.numero}`,
      t.estatus,
      c?.nombre || t.displayName || 'Participante',
      c?.cedula || '—',
      c?.telefono || '—',
      fmtDateTime(t.reservedAtMs),
      fmtDateTime(t.paidAtMs),
    ];
  });

  autoTable(pdf, {
    startY: 53,
    head: [['Boleto', 'Estatus', 'Participante', 'Cédula', 'Teléfono', 'Reservado', 'Pagado']],
    body: rows.length
      ? rows
      : [['—', '—', `Sin boletos para el filtro ${filtro}.`, '—', '—', '—', '—']],
    theme: 'grid',
    styles: {
      fontSize: 8,
      cellPadding: 2.4,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.2,
      valign: 'middle',
    },
    headStyles: {
      fillColor: [15, 23, 42],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    columnStyles: {
      0: { cellWidth: 20, halign: 'center', fontStyle: 'bold' },
      1: { cellWidth: 26, halign: 'center', fontStyle: 'bold' },
      3: { cellWidth: 28 },
      4: { cellWidth: 34 },
      5: { cellWidth: 36 },
      6: { cellWidth: 36 },
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 1) {
        const val = String(data.cell.raw || '');
        if (val === 'PAGADO') {
          data.cell.styles.textColor = [4, 120, 87];
          data.cell.styles.fillColor = [236, 253, 245];
        } else if (val === 'ESPERA') {
          data.cell.styles.textColor = [109, 40, 217];
          data.cell.styles.fillColor = [245, 243, 255];
        } else if (val === 'RESERVADO') {
          data.cell.styles.textColor = [29, 78, 216];
          data.cell.styles.fillColor = [239, 246, 255];
        }
      }
    },
    margin: { left: 14, right: 14, bottom: 18 },
  });

  addPageFooters(pdf, `Historial de Boletos (${filtro})`);
  pdf.save(`mega-rifas-historial-${filtro.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf`);
}
