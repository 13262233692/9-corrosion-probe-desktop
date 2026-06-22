const fs = require('fs');
const path = require('path');
const { deviceRepo, probeReadingRepo, corrosionRateRepo, alarmEventRepo } = require('../database');
const { groupComparisonService } = require('./groupComparison');

let jsPDF = null;
let autoTable = null;

function loadPdfLibs() {
  if (!jsPDF) {
    try {
      const { jsPDF: JSPDF } = require('jspdf');
      jsPDF = JSPDF;
      const autoTableModule = require('jspdf-autotable');
      autoTable = autoTableModule.default || autoTableModule;
    } catch (e) {
      throw new Error('PDF导出库加载失败');
    }
  }
}

function generateCsvReport(deviceAddress, startTime, endTime) {
  const device = deviceRepo.findByAddress(deviceAddress);
  if (!device) {
    throw new Error(`设备不存在: ${deviceAddress}`);
  }

  const readings = probeReadingRepo.findByTimeRange(deviceAddress, startTime, endTime);
  const rates = corrosionRateRepo.findByDevice(deviceAddress, 100);
  const alarms = alarmEventRepo.findAll(100, 0).filter(a => a.device_address === deviceAddress);

  let csv = '\uFEFF';

  csv += '设备信息\n';
  csv += `设备地址,${device.device_address}\n`;
  csv += `设备名称,${device.name}\n`;
  csv += `安装位置,${device.location || '-'}\n`;
  csv += `探针类型,${device.probe_type || '-'}\n`;
  csv += `初始电阻,${device.initial_resistance} mΩ\n`;
  csv += `报警阈值,${device.alarm_threshold} mm/y\n`;
  csv += '\n';

  csv += '数据记录\n';
  csv += '序号,时间,电阻(mΩ),温度(°C),状态,CRC有效\n';
  readings.forEach((r, i) => {
    const time = new Date(r.timestamp).toLocaleString('zh-CN');
    const status = r.status_byte ? '异常' : '正常';
    const crc = r.crc_valid ? '是' : '否';
    csv += `${i + 1},${time},${r.resistance},${r.temperature},${status},${crc}\n`;
  });
  csv += '\n';

  csv += '腐蚀速率\n';
  csv += '序号,计算时间,速率(mm/y),样本数\n';
  rates.forEach((r, i) => {
    const time = new Date(r.calculated_at).toLocaleString('zh-CN');
    csv += `${i + 1},${time},${r.rate.toFixed(6)},${r.sample_count}\n`;
  });
  csv += '\n';

  csv += '报警记录\n';
  csv += '序号,时间,类型,级别,消息,已确认\n';
  alarms.forEach((a, i) => {
    const time = new Date(a.created_at).toLocaleString('zh-CN');
    const ack = a.acknowledged ? '是' : '否';
    csv += `${i + 1},${time},${a.alarm_type},${a.level},${a.message},${ack}\n`;
  });

  return csv;
}

function exportCsv(filePath, deviceAddress, startTime, endTime) {
  const csv = generateCsvReport(deviceAddress, startTime, endTime);
  fs.writeFileSync(filePath, csv, 'utf-8');
  return filePath;
}

function generatePdfReport(deviceAddress, startTime, endTime) {
  loadPdfLibs();

  const device = deviceRepo.findByAddress(deviceAddress);
  if (!device) {
    throw new Error(`设备不存在: ${deviceAddress}`);
  }

  const readings = probeReadingRepo.findByTimeRange(deviceAddress, startTime, endTime);
  const rates = corrosionRateRepo.findByDevice(deviceAddress, 20);
  const alarms = alarmEventRepo.findAll(50, 0).filter(a => a.device_address === deviceAddress);

  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('腐蚀探针巡检报告', pageWidth / 2, 20, { align: 'center' });

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`生成时间: ${new Date().toLocaleString('zh-CN')}`, 14, 30);
  doc.text(`报告周期: ${new Date(startTime).toLocaleString('zh-CN')} ~ ${new Date(endTime).toLocaleString('zh-CN')}`, 14, 36);

  let yPos = 45;

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('一、设备信息', 14, yPos);
  yPos += 8;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  const deviceData = [
    ['设备地址', device.device_address, '设备名称', device.name],
    ['安装位置', device.location || '-', '探针类型', device.probe_type || '-'],
    ['初始电阻', `${device.initial_resistance} mΩ`, '报警阈值', `${device.alarm_threshold} mm/y`]
  ];

  autoTable(doc, {
    startY: yPos,
    body: deviceData,
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: {
      0: { cellWidth: 25, fontStyle: 'bold', fillColor: [240, 240, 240] },
      1: { cellWidth: 50 },
      2: { cellWidth: 25, fontStyle: 'bold', fillColor: [240, 240, 240] },
      3: { cellWidth: 50 }
    }
  });

  yPos = doc.lastAutoTable.finalY + 10;

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('二、数据统计', 14, yPos);
  yPos += 8;

  const validReadings = readings.filter(r => r.crc_valid);
  const avgResistance = validReadings.length > 0
    ? (validReadings.reduce((sum, r) => sum + r.resistance, 0) / validReadings.length).toFixed(4)
    : '-';
  const avgTemperature = validReadings.length > 0
    ? (validReadings.reduce((sum, r) => sum + r.temperature, 0) / validReadings.length).toFixed(2)
    : '-';
  const latestRate = rates.length > 0 ? rates[0].rate.toFixed(6) : '-';

  const statsData = [
    ['数据总数', readings.length, '有效数据', validReadings.length],
    ['平均电阻', `${avgResistance} mΩ`, '平均温度', `${avgTemperature} °C`],
    ['最新腐蚀速率', `${latestRate} mm/y`, '报警次数', alarms.length]
  ];

  autoTable(doc, {
    startY: yPos,
    body: statsData,
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: {
      0: { cellWidth: 30, fontStyle: 'bold', fillColor: [240, 240, 240] },
      1: { cellWidth: 45 },
      2: { cellWidth: 30, fontStyle: 'bold', fillColor: [240, 240, 240] },
      3: { cellWidth: 45 }
    }
  });

  yPos = doc.lastAutoTable.finalY + 10;

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('三、最近腐蚀速率', 14, yPos);
  yPos += 8;

  const rateRows = rates.slice(0, 10).map((r, i) => [
    i + 1,
    new Date(r.calculated_at).toLocaleString('zh-CN'),
    r.rate.toFixed(6),
    r.sample_count
  ]);

  autoTable(doc, {
    startY: yPos,
    head: [['序号', '计算时间', '速率 (mm/y)', '样本数']],
    body: rateRows,
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [66, 139, 202] }
  });

  if (doc.lastAutoTable.finalY > 250) {
    doc.addPage();
    yPos = 20;
  } else {
    yPos = doc.lastAutoTable.finalY + 10;
  }

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('四、报警记录', 14, yPos);
  yPos += 8;

  const alarmRows = alarms.slice(0, 20).map((a, i) => [
    i + 1,
    new Date(a.created_at).toLocaleString('zh-CN'),
    a.alarm_type,
    a.level,
    a.message.substring(0, 30)
  ]);

  autoTable(doc, {
    startY: yPos,
    head: [['序号', '时间', '类型', '级别', '消息']],
    body: alarmRows.length > 0 ? alarmRows : [['-', '-', '-', '-', '无报警记录']],
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [217, 83, 79] }
  });

  return doc;
}

function exportPdf(filePath, deviceAddress, startTime, endTime) {
  const doc = generatePdfReport(deviceAddress, startTime, endTime);
  doc.save(filePath);
  return filePath;
}

function generateInspectionReport(type, deviceAddresses, startTime, endTime) {
  const result = {
    reportType: type,
    generatedAt: Date.now(),
    period: { start: startTime, end: endTime },
    devices: []
  };

  for (const addr of deviceAddresses) {
    const device = deviceRepo.findByAddress(addr);
    if (!device) continue;

    const readings = probeReadingRepo.findByTimeRange(addr, startTime, endTime);
    const rates = corrosionRateRepo.findByDevice(addr, 10);
    const alarms = alarmEventRepo.findAll(100, 0).filter(a => a.device_address === addr);
    const unacknowledged = alarms.filter(a => !a.acknowledged);

    const latestRate = rates.length > 0 ? rates[0] : null;
    const validReadings = readings.filter(r => r.crc_valid);

    result.devices.push({
      device_address: addr,
      name: device.name,
      location: device.location,
      reading_count: readings.length,
      valid_reading_count: validReadings.length,
      latest_corrosion_rate: latestRate ? latestRate.rate : null,
      alarm_count: alarms.length,
      unacknowledged_count: unacknowledged.length,
      status: unacknowledged.length > 0 ? '异常' : '正常'
    });
  }

  return result;
}

function generateComparisonReport(deviceAddresses, options = {}) {
  const result = groupComparisonService.generateComparisonReport(deviceAddresses, options);

  const deviceInfos = deviceAddresses.map(addr => {
    const device = deviceRepo.findByAddress(addr);
    return device || { device_address: addr, name: `设备#${addr}` };
  });

  return {
    generated_at: Date.now(),
    window_hours: options.windowHours || 24,
    devices: deviceInfos,
    ...result
  };
}

function exportComparisonReport(filePath, deviceAddresses, options = {}) {
  const format = options?.format || (filePath.toLowerCase().endsWith('.csv') ? 'csv' : 'pdf');
  const report = generateComparisonReport(deviceAddresses, options);

  if (format === 'csv') {
    return _exportComparisonCsv(filePath, report);
  } else {
    return _exportComparisonPdf(filePath, report);
  }
}

function _exportComparisonCsv(filePath, report) {
  let csv = '\uFEFF';

  csv += '多设备对比分析报告\n';
  csv += `生成时间,${new Date(report.generated_at).toLocaleString('zh-CN')}\n`;
  csv += `分析窗口,${report.window_hours}小时\n\n`;

  csv += '一、对比设备\n';
  csv += '地址,名称,位置,类型,初始电阻(mΩ)\n';
  for (const d of report.devices) {
    csv += `${d.device_address},${d.name},${d.location || '-'},${d.probe_type || '-'},${d.initial_resistance || 0}\n`;
  }
  csv += '\n';

  csv += '二、单设备腐蚀速率\n';
  csv += '设备,速率(mm/y),样本数,状态\n';
  for (const r of report.details) {
    const status = r.error ? `错误:${r.error}` : (r.sample_count >= 2 ? '正常' : '采样不足');
    csv += `${r.device_name},${r.rate.toFixed(6)},${r.sample_count},${status}\n`;
  }
  csv += '\n';

  csv += '三、对比统计\n';
  const s = report.summary || {};
  csv += `有效设备数,${s.valid_devices || 0}/${s.total_devices || 0}\n`;
  csv += `平均速率,${s.mean_rate ? s.mean_rate.toFixed(6) : '-'} mm/y\n`;
  csv += `最低速率,${s.min_rate ? s.min_rate.toFixed(6) : '-'} mm/y (${s.slowest_device?.device_name || '-'})\n`;
  csv += `最高速率,${s.max_rate ? s.max_rate.toFixed(6) : '-'} mm/y (${s.fastest_device?.device_name || '-'})\n`;
  csv += `最大偏差率,${s.max_deviation_ratio ? (s.max_deviation_ratio * 100).toFixed(1) : 0}%\n`;
  csv += `超阈值设备数,${s.over_threshold_count || 0}\n\n`;

  csv += '四、分析结论\n';
  (report.conclusions || [report.conclusion]).forEach((line, i) => {
    csv += `结论${i + 1},${line}\n`;
  });

  fs.writeFileSync(filePath, csv, 'utf-8');
  return filePath;
}

function _exportComparisonPdf(filePath, report) {
  loadPdfLibs();

  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('多设备腐蚀对比分析报告', pageWidth / 2, 20, { align: 'center' });

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`生成时间: ${new Date(report.generated_at).toLocaleString('zh-CN')}`, 14, 30);
  doc.text(`分析窗口: ${report.window_hours}小时`, 14, 36);

  let yPos = 45;

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('一、对比设备清单', 14, yPos);
  yPos += 8;

  const deviceRows = report.devices.map((d, i) => [
    i + 1,
    d.device_address,
    d.name,
    d.location || '-',
    d.initial_resistance || 0
  ]);

  autoTable(doc, {
    startY: yPos,
    head: [['序号', '地址', '名称', '位置', '初始电阻(mΩ)']],
    body: deviceRows,
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [66, 139, 202] }
  });

  yPos = doc.lastAutoTable.finalY + 10;

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('二、单设备腐蚀速率对比', 14, yPos);
  yPos += 8;

  const rateRows = report.details.map((r, i) => [
    i + 1,
    r.device_name,
    r.rate.toFixed(6),
    r.sample_count,
    r.error ? '错误' : (r.sample_count >= 2 ? '有效' : '采样不足')
  ]);

  autoTable(doc, {
    startY: yPos,
    head: [['序号', '设备', '速率(mm/y)', '样本数', '状态']],
    body: rateRows,
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [66, 139, 202] }
  });

  yPos = doc.lastAutoTable.finalY + 10;
  if (yPos > 230) { doc.addPage(); yPos = 20; }

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('三、组对比统计', 14, yPos);
  yPos += 8;

  const s = report.summary || {};
  const statsData = [
    ['有效设备数', `${s.valid_devices || 0} / ${s.total_devices || 0}`, '超阈值设备数', s.over_threshold_count || 0],
    ['平均速率', `${s.mean_rate ? s.mean_rate.toFixed(6) : '-'} mm/y`, '最大偏差率', `${s.max_deviation_ratio ? (s.max_deviation_ratio * 100).toFixed(1) : 0}%`],
    ['最低速率', `${s.min_rate ? s.min_rate.toFixed(6) : '-'} mm/y`, '最低设备', s.slowest_device?.device_name || '-'],
    ['最高速率', `${s.max_rate ? s.max_rate.toFixed(6) : '-'} mm/y`, '最高设备', s.fastest_device?.device_name || '-']
  ];

  autoTable(doc, {
    startY: yPos,
    body: statsData,
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: {
      0: { cellWidth: 30, fontStyle: 'bold', fillColor: [240, 240, 240] },
      1: { cellWidth: 50 },
      2: { cellWidth: 30, fontStyle: 'bold', fillColor: [240, 240, 240] },
      3: { cellWidth: 50 }
    }
  });

  yPos = doc.lastAutoTable.finalY + 10;
  if (yPos > 230) { doc.addPage(); yPos = 20; }

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('四、分析结论', 14, yPos);
  yPos += 8;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  (report.conclusions || [report.conclusion]).forEach((line, i) => {
    const wrapped = doc.splitTextToSize(`结论${i + 1}: ${line}`, pageWidth - 28);
    doc.text(wrapped, 14, yPos);
    yPos += wrapped.length * 5 + 2;
  });

  doc.save(filePath);
  return filePath;
}

module.exports = {
  generateCsvReport,
  exportCsv,
  generatePdfReport,
  exportPdf,
  generateInspectionReport,
  generateComparisonReport,
  exportComparisonReport
};
