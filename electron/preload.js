const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  serial: {
    listPorts: () => ipcRenderer.invoke('serial:list-ports'),
    connect: (config) => ipcRenderer.invoke('serial:connect', config),
    disconnect: () => ipcRenderer.invoke('serial:disconnect'),
    getStatus: () => ipcRenderer.invoke('serial:status'),
    updateInterval: (interval) => ipcRenderer.invoke('serial:update-interval', interval),
    onReading: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('serial:reading', listener);
      return () => ipcRenderer.removeListener('serial:reading', listener);
    },
    onConnected: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('serial:connected', listener);
      return () => ipcRenderer.removeListener('serial:connected', listener);
    },
    onDisconnected: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('serial:disconnected', listener);
      return () => ipcRenderer.removeListener('serial:disconnected', listener);
    },
    onReconnecting: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('serial:reconnecting', listener);
      return () => ipcRenderer.removeListener('serial:reconnecting', listener);
    },
    onReconnected: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('serial:reconnected', listener);
      return () => ipcRenderer.removeListener('serial:reconnected', listener);
    },
    onError: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('serial:error', listener);
      return () => ipcRenderer.removeListener('serial:error', listener);
    },
    onFrameError: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('serial:frame-error', listener);
      return () => ipcRenderer.removeListener('serial:frame-error', listener);
    }
  },

  device: {
    list: () => ipcRenderer.invoke('device:list'),
    create: (device) => ipcRenderer.invoke('device:create', device),
    update: (address, updates) => ipcRenderer.invoke('device:update', address, updates),
    delete: (address) => ipcRenderer.invoke('device:delete', address),
    get: (address) => ipcRenderer.invoke('device:get', address)
  },

  readings: {
    list: (deviceAddress, limit, offset) => ipcRenderer.invoke('readings:list', deviceAddress, limit, offset),
    range: (deviceAddress, startTime, endTime) => ipcRenderer.invoke('readings:range', deviceAddress, startTime, endTime),
    latest: (deviceAddress) => ipcRenderer.invoke('readings:latest', deviceAddress)
  },

  corrosion: {
    getRate: (deviceAddress, options) => ipcRenderer.invoke('corrosion:rate', deviceAddress, options),
    getMultiWindow: (deviceAddress) => ipcRenderer.invoke('corrosion:multi-window', deviceAddress),
    getTrend: (deviceAddress, startTime, endTime, interval) =>
      ipcRenderer.invoke('corrosion:trend', deviceAddress, startTime, endTime, interval),
    getHistory: (deviceAddress, limit) => ipcRenderer.invoke('corrosion:history', deviceAddress, limit)
  },

  alarm: {
    list: (limit, offset) => ipcRenderer.invoke('alarms:list', limit, offset),
    unacknowledged: () => ipcRenderer.invoke('alarms:unacknowledged'),
    acknowledge: (id) => ipcRenderer.invoke('alarms:acknowledge', id),
    onNewAlarm: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('alarm:new', listener);
      return () => ipcRenderer.removeListener('alarm:new', listener);
    }
  },

  config: {
    get: (key, defaultValue) => ipcRenderer.invoke('config:get', key, defaultValue),
    set: (key, value) => ipcRenderer.invoke('config:set', key, value)
  },

  report: {
    exportCsv: (deviceAddress, startTime, endTime) =>
      ipcRenderer.invoke('report:export-csv', deviceAddress, startTime, endTime),
    exportPdf: (deviceAddress, startTime, endTime) =>
      ipcRenderer.invoke('report:export-pdf', deviceAddress, startTime, endTime),
    inspection: (type, deviceAddresses, startTime, endTime) =>
      ipcRenderer.invoke('report:inspection', type, deviceAddresses, startTime, endTime)
  },

  protocol: {
    compensate: (resistance, temperature) =>
      ipcRenderer.invoke('protocol:compensate', resistance, temperature)
  }
});
