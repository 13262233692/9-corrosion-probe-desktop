const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const {
  initDatabase,
  closeDatabase,
  deviceRepo,
  probeReadingRepo,
  corrosionRateRepo,
  alarmEventRepo,
  configRepo,
  probeGroupRepo,
  groupAlarmRuleRepo
} = require('./database');

const { serialManager } = require('./serial');
const { alarmService } = require('./services/alarm');
const {
  calculateSlidingWindowRate,
  calculateMultipleWindows,
  calculateCorrosionTrend,
  storeCorrosionRate
} = require('./services/corrosionRate');
const {
  exportCsv,
  exportPdf,
  generateInspectionReport,
  exportComparisonReport
} = require('./services/report');
const { temperatureCompensation } = require('./protocol');
const { groupComparisonService } = require('./services/groupComparison');

let mainWindow = null;
let rateCalcTimer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupIpcHandlers() {
  ipcMain.handle('serial:list-ports', async () => {
    try {
      return { success: true, data: await serialManager.listPorts() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('serial:connect', async (event, config) => {
    try {
      const result = await serialManager.connect(config);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('serial:disconnect', async () => {
    try {
      await serialManager.disconnect();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('serial:status', () => {
    return { success: true, data: serialManager.getStatus() };
  });

  ipcMain.handle('serial:update-interval', (event, interval) => {
    serialManager.updateSampleInterval(interval);
    return { success: true };
  });

  ipcMain.handle('device:list', () => {
    try {
      return { success: true, data: deviceRepo.findAll() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('device:create', (event, device) => {
    try {
      const id = deviceRepo.create(device);
      return { success: true, data: { id, ...device } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('device:update', (event, address, updates) => {
    try {
      const changes = deviceRepo.update(address, updates);
      return { success: true, data: { changes } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('device:delete', (event, address) => {
    try {
      const changes = deviceRepo.delete(address);
      return { success: true, data: { changes } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('device:get', (event, address) => {
    try {
      return { success: true, data: deviceRepo.findByAddress(address) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('readings:list', (event, deviceAddress, limit, offset) => {
    try {
      return {
        success: true,
        data: probeReadingRepo.findByDevice(deviceAddress, limit || 100, offset || 0)
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('readings:range', (event, deviceAddress, startTime, endTime) => {
    try {
      return {
        success: true,
        data: probeReadingRepo.findByTimeRange(deviceAddress, startTime, endTime)
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('readings:latest', (event, deviceAddress) => {
    try {
      return { success: true, data: probeReadingRepo.findLatest(deviceAddress) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('corrosion:rate', (event, deviceAddress, options) => {
    try {
      const rate = calculateSlidingWindowRate(deviceAddress, options);
      return { success: true, data: rate };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('corrosion:multi-window', (event, deviceAddress) => {
    try {
      const rates = calculateMultipleWindows(deviceAddress);
      return { success: true, data: rates };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('corrosion:trend', (event, deviceAddress, startTime, endTime, interval) => {
    try {
      const trend = calculateCorrosionTrend(
        deviceAddress,
        startTime,
        endTime,
        interval || 1
      );
      return { success: true, data: trend };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('corrosion:history', (event, deviceAddress, limit) => {
    try {
      return {
        success: true,
        data: corrosionRateRepo.findByDevice(deviceAddress, limit || 50)
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('alarms:list', (event, limit, offset) => {
    try {
      return {
        success: true,
        data: alarmService.getAlarms(limit || 100, offset || 0)
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('alarms:unacknowledged', () => {
    try {
      return { success: true, data: alarmService.getUnacknowledged() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('alarms:acknowledge', (event, id) => {
    try {
      alarmService.acknowledgeAlarm(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('config:get', (event, key, defaultValue) => {
    try {
      return { success: true, data: configRepo.get(key, defaultValue) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('config:set', (event, key, value) => {
    try {
      configRepo.set(key, value);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report:export-csv', async (event, deviceAddress, startTime, endTime) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出 CSV 报告',
        defaultPath: `腐蚀报告_${deviceAddress}_${Date.now()}.csv`,
        filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      const filePath = exportCsv(result.filePath, deviceAddress, startTime, endTime);
      return { success: true, data: { filePath } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report:export-pdf', async (event, deviceAddress, startTime, endTime) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出 PDF 报告',
        defaultPath: `腐蚀报告_${deviceAddress}_${Date.now()}.pdf`,
        filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      const filePath = exportPdf(result.filePath, deviceAddress, startTime, endTime);
      return { success: true, data: { filePath } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report:inspection', (event, type, deviceAddresses, startTime, endTime) => {
    try {
      const report = generateInspectionReport(type, deviceAddresses, startTime, endTime);
      return { success: true, data: report };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('protocol:compensate', (event, resistance, temperature) => {
    try {
      const result = temperatureCompensation(resistance, temperature);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('group:list', () => {
    try {
      return { success: true, data: probeGroupRepo.findAll() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('group:create', (event, group) => {
    try {
      const id = probeGroupRepo.create(group);
      return { success: true, data: { id, ...group } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('group:update', (event, id, updates) => {
    try {
      const changes = probeGroupRepo.update(id, updates);
      return { success: true, data: { changes } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('group:delete', (event, id) => {
    try {
      const changes = probeGroupRepo.delete(id);
      return { success: true, data: { changes } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('group:get', (event, id) => {
    try {
      return { success: true, data: probeGroupRepo.findById(id) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('group-rule:list', (event, groupId) => {
    try {
      const data = groupId
        ? groupAlarmRuleRepo.findByGroupId(groupId)
        : groupAlarmRuleRepo.findAll();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('group-rule:create', (event, rule) => {
    try {
      const id = groupAlarmRuleRepo.create(rule);
      return { success: true, data: { id, ...rule } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('group-rule:update', (event, id, updates) => {
    try {
      const changes = groupAlarmRuleRepo.update(id, updates);
      return { success: true, data: { changes } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('group-rule:delete', (event, id) => {
    try {
      const changes = groupAlarmRuleRepo.delete(id);
      return { success: true, data: { changes } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('comparison:rates', (event, deviceAddresses, options) => {
    try {
      const data = groupComparisonService.getMultiDeviceRates(deviceAddresses, options);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('comparison:trends', (event, deviceAddresses, startTime, endTime, options) => {
    try {
      const data = groupComparisonService.getMultiDeviceTrends(
        deviceAddresses, startTime, endTime, options
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('comparison:evaluate', (event, groupId) => {
    try {
      const data = groupId
        ? groupComparisonService.evaluateGroup(groupId)
        : groupComparisonService.evaluateAllGroups();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('comparison:report', (event, deviceAddresses, options) => {
    try {
      const data = groupComparisonService.generateComparisonReport(deviceAddresses, options);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report:export-comparison', async (event, deviceAddresses, options) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出对比报告',
        defaultPath: `多设备对比报告_${Date.now()}.${options?.format || 'pdf'}`,
        filters: options?.format === 'csv'
          ? [{ name: 'CSV 文件', extensions: ['csv'] }]
          : [{ name: 'PDF 文件', extensions: ['pdf'] }]
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      const filePath = exportComparisonReport(result.filePath, deviceAddresses, options);
      return { success: true, data: { filePath } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

function setupSerialEvents() {
  serialManager.on('reading', (reading) => {
    if (mainWindow) {
      mainWindow.webContents.send('serial:reading', reading);
    }

    const alarms = alarmService.checkReading(reading);
    if (alarms.length > 0 && mainWindow) {
      mainWindow.webContents.send('alarm:new', alarms);
    }
  });

  serialManager.on('connected', (config) => {
    if (mainWindow) {
      mainWindow.webContents.send('serial:connected', config);
    }
    startRateCalculation();
  });

  serialManager.on('disconnected', () => {
    if (mainWindow) {
      mainWindow.webContents.send('serial:disconnected');
    }
    stopRateCalculation();

    const alarm = alarmService.deviceDisconnected(serialManager.config.deviceAddress);
    if (alarm && mainWindow) {
      mainWindow.webContents.send('alarm:new', [alarm]);
    }
  });

  serialManager.on('reconnecting', (info) => {
    if (mainWindow) {
      mainWindow.webContents.send('serial:reconnecting', info);
    }
  });

  serialManager.on('reconnected', () => {
    if (mainWindow) {
      mainWindow.webContents.send('serial:reconnected');
    }
    startRateCalculation();
  });

  serialManager.on('connection-error', (err) => {
    if (mainWindow) {
      mainWindow.webContents.send('serial:error', err);
    }
  });

  serialManager.on('frame-error', (frame) => {
    if (mainWindow) {
      mainWindow.webContents.send('serial:frame-error', frame);
    }
  });
}

function startRateCalculation() {
  stopRateCalculation();
  rateCalcTimer = setInterval(() => {
    const devices = deviceRepo.findAll();
    for (const device of devices) {
      try {
        const rateResult = storeCorrosionRate(device.device_address, 24);
        if (rateResult) {
          const alarm = alarmService.checkCorrosionRate(device.device_address, rateResult.rate);
          if (alarm && mainWindow) {
            mainWindow.webContents.send('alarm:new', [alarm]);
          }
        }
      } catch (e) {}
    }

    try {
      const evalResult = groupComparisonService.evaluateAllGroups();
      const allAlarms = [];
      for (const grp of evalResult.results || []) {
        if (grp.alarms && grp.alarms.length > 0) {
          for (const a of grp.alarms) {
            allAlarms.push(a);
          }
        }
      }
      if (allAlarms.length > 0 && mainWindow) {
        mainWindow.webContents.send('group-alarm:new', allAlarms);
      }
    } catch (e) {}
  }, 60 * 1000);
}

function stopRateCalculation() {
  if (rateCalcTimer) {
    clearInterval(rateCalcTimer);
    rateCalcTimer = null;
  }
}

app.whenReady().then(() => {
  initDatabase();
  setupIpcHandlers();
  setupSerialEvents();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopRateCalculation();
  serialManager.disconnect().catch(() => {});
  closeDatabase();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
