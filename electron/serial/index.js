const { SerialPort } = require('serialport');
const { FrameParser, buildReadCommand, validateReading } = require('../protocol');
const { probeReadingRepo, deviceRepo, configRepo } = require('../database');
const { EventEmitter } = require('events');

const DEFAULT_RECONNECT_INTERVAL = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;

class SerialManager extends EventEmitter {
  constructor() {
    super();
    this.port = null;
    this.frameParser = new FrameParser();
    this.config = {
      path: '',
      baudRate: 9600,
      deviceAddress: 1,
      sampleInterval: 1000
    };
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.readTimer = null;
    this.lastReading = null;
    this.offlineCache = [];
    this.maxCacheSize = 10000;
  }

  async listPorts() {
    try {
      const ports = await SerialPort.list();
      return ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        vendorId: p.vendorId,
        productId: p.productId
      }));
    } catch (err) {
      throw new Error(`获取串口列表失败: ${err.message}`);
    }
  }

  async connect(config) {
    if (this.isConnecting) {
      throw new Error('正在连接中，请稍候...');
    }

    this.config = { ...this.config, ...config };
    this.isConnecting = true;
    this.reconnectAttempts = 0;

    try {
      await this._doConnect();
      this.isConnecting = false;
      this.isConnected = true;
      this.emit('connected', this.config);
      this._startReading();
      return true;
    } catch (err) {
      this.isConnecting = false;
      this.emit('connection-error', err.message);
      throw err;
    }
  }

  _doConnect() {
    return new Promise((resolve, reject) => {
      if (this.port) {
        try {
          this.port.removeAllListeners();
          if (this.port.isOpen) {
            this.port.close(() => {});
          }
        } catch (e) {}
        this.port = null;
      }

      this.frameParser.reset();

      this.port = new SerialPort({
        path: this.config.path,
        baudRate: Number(this.config.baudRate),
        autoOpen: false
      });

      this.port.on('data', (data) => this._onData(data));
      this.port.on('error', (err) => this._onError(err));
      this.port.on('close', () => this._onClose());
      this.port.on('open', () => {
        resolve();
      });

      this.port.open((err) => {
        if (err) {
          reject(new Error(`打开串口失败: ${err.message}`));
        }
      });
    });
  }

  _onData(data) {
    const frames = this.frameParser.feed(data);

    for (const frame of frames) {
      if (frame.error) {
        this.emit('frame-error', frame);
        continue;
      }

      const validation = validateReading(frame, this.lastReading);

      const readingData = {
        ...frame,
        device_address: frame.device_address,
        timestamp: frame.timestamp || Date.now()
      };

      try {
        const id = probeReadingRepo.create(readingData);
        readingData.id = id;
      } catch (err) {
        if (this.offlineCache.length < this.maxCacheSize) {
          this.offlineCache.push(readingData);
        }
        this.emit('cache-add', readingData);
      }

      if (!validation.valid) {
        this.emit('reading-warning', { reading: frame, errors: validation.errors });
      }

      this.lastReading = frame;
      this.emit('reading', frame);
      this.reconnectAttempts = 0;
    }
  }

  _onError(err) {
    this.emit('error', err.message);
  }

  _onClose() {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this._stopReading();

    if (wasConnected) {
      this.emit('disconnected');
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.emit('reconnect-failed', '已达到最大重连次数');
      return;
    }

    this.reconnectAttempts++;
    this.emit('reconnecting', {
      attempt: this.reconnectAttempts,
      maxAttempts: MAX_RECONNECT_ATTEMPTS
    });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this._doConnect();
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.emit('reconnected');
        this._startReading();
        this._flushCache();
      } catch (err) {
        this._scheduleReconnect();
      }
    }, DEFAULT_RECONNECT_INTERVAL);
  }

  _startReading() {
    this._stopReading();

    this.readTimer = setInterval(() => {
      if (this.port && this.port.isOpen) {
        const cmd = buildReadCommand(this.config.deviceAddress);
        this.port.write(cmd, (err) => {
          if (err) {
            this.emit('write-error', err.message);
          }
        });
      }
    }, this.config.sampleInterval);
  }

  _stopReading() {
    if (this.readTimer) {
      clearInterval(this.readTimer);
      this.readTimer = null;
    }
  }

  async _flushCache() {
    if (this.offlineCache.length === 0) return;

    const cached = [...this.offlineCache];
    this.offlineCache = [];

    let successCount = 0;
    for (const reading of cached) {
      try {
        probeReadingRepo.create(reading);
        successCount++;
      } catch (e) {}
    }

    this.emit('cache-flushed', { success: successCount, total: cached.length });
  }

  async disconnect() {
    this._stopReading();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.port) {
      return new Promise((resolve) => {
        if (this.port.isOpen) {
          this.port.close((err) => {
            this.port = null;
            this.isConnected = false;
            this.isConnecting = false;
            this.emit('disconnected');
            resolve(!err);
          });
        } else {
          this.port = null;
          this.isConnected = false;
          this.isConnecting = false;
          resolve(true);
        }
      });
    }

    this.isConnected = false;
    this.isConnecting = false;
    return true;
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      config: { ...this.config },
      reconnectAttempts: this.reconnectAttempts,
      cacheSize: this.offlineCache.length,
      lastReading: this.lastReading
    };
  }

  updateSampleInterval(interval) {
    this.config.sampleInterval = Number(interval);
    if (this.isConnected) {
      this._startReading();
    }
  }

  updateDeviceAddress(address) {
    this.config.deviceAddress = Number(address);
  }
}

const serialManager = new SerialManager();

module.exports = {
  SerialManager,
  serialManager
};
