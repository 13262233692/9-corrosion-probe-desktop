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
    this._connectionLock = Promise.resolve();
    this._connectionId = 0;
    this._manualDisconnect = false;
    this._pendingFrameBuffer = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.readTimer = null;
    this.lastReading = null;
    this.offlineCache = [];
    this.maxCacheSize = 10000;

    this._onDataBound = this._onData.bind(this);
    this._onErrorBound = this._onError.bind(this);
    this._onCloseBound = this._onClose.bind(this);
    this._onOpenBound = this._onOpen.bind(this);
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
    this._manualDisconnect = false;
    this.reconnectAttempts = 0;

    return this._withLock(async () => {
      if (this.isConnected && this.port && this.port.isOpen) {
        return true;
      }

      if (this.port) {
        await this._cleanupPort();
      }

      this.config = { ...this.config, ...config };
      this.isConnecting = true;
      this._connectionId++;
      const currentConnectionId = this._connectionId;

      try {
        await this._doConnect(currentConnectionId);

        if (this._connectionId !== currentConnectionId) {
          await this._cleanupPort().catch(() => {});
          throw new Error('连接已被新的连接请求取代');
        }

        this.isConnecting = false;
        this.isConnected = true;
        this.emit('connected', this.config);
        this._startReading();
        return true;
      } catch (err) {
        this.isConnecting = false;
        this._cleanupPort().catch(() => {});
        this.emit('connection-error', err.message);
        throw err;
      }
    });
  }

  _withLock(operation) {
    this._connectionLock = this._connectionLock
      .then(() => operation())
      .catch(err => {
        throw err;
      });
    return this._connectionLock;
  }

  _doConnect(connectionId) {
    return new Promise((resolve, reject) => {
      const openHandler = (err) => {
        if (this._connectionId !== connectionId) {
          reject(new Error('连接已过期'));
          return;
        }
        if (err) {
          reject(new Error(`打开串口失败: ${err.message}`));
        }
      };

      const setupPort = () => {
        if (this._pendingFrameBuffer && this._pendingFrameBuffer.length > 0) {
          this.frameParser.buffer = this._pendingFrameBuffer;
          this._pendingFrameBuffer = null;
        } else {
          this.frameParser.reset();
        }

        this.port = new SerialPort({
          path: this.config.path,
          baudRate: Number(this.config.baudRate),
          autoOpen: false
        });

        this.port.on('data', this._onDataBound);
        this.port.on('error', this._onErrorBound);
        this.port.on('close', this._onCloseBound);
        this.port.on('open', this._onOpenBound);

        this._openResolve = resolve;
        this._openReject = reject;
        this._currentConnectionId = connectionId;

        this.port.open(openHandler);
      };

      if (this.port) {
        this._cleanupPort()
          .then(setupPort)
          .catch(() => setupPort());
      } else {
        setupPort();
      }
    });
  }

  _onOpen() {
    if (this._openResolve && this._currentConnectionId === this._connectionId) {
      this._openResolve();
    }
    this._openResolve = null;
    this._openReject = null;
  }

  async _cleanupPort() {
    return new Promise((resolve) => {
      const port = this.port;
      if (!port) {
        resolve();
        return;
      }

      this._pendingFrameBuffer = Buffer.from(this.frameParser.buffer);

      try {
        port.removeListener('data', this._onDataBound);
        port.removeListener('error', this._onErrorBound);
        port.removeListener('close', this._onCloseBound);
        port.removeListener('open', this._onOpenBound);
      } catch (e) {}

      this._stopReading();

      if (port.isOpen) {
        port.drain(() => {
          port.close((err) => {
            this.port = null;
            resolve(!err);
          });
        });
      } else {
        this.port = null;
        resolve(true);
      }
    });
  }

  _onData(data) {
    if (!this.port || this._connectionId !== this._currentConnectionId) {
      return;
    }

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

    if (this._pendingFrameBuffer === null) {
      this._pendingFrameBuffer = Buffer.from(this.frameParser.buffer);
    }

    if (wasConnected && !this._manualDisconnect) {
      this.emit('disconnected');
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.emit('reconnect-failed', '已达到最大重连次数');
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectAttempts++;
    this.emit('reconnecting', {
      attempt: this.reconnectAttempts,
      maxAttempts: MAX_RECONNECT_ATTEMPTS
    });

    this.reconnectTimer = setTimeout(() => {
      this._withLock(async () => {
        if (this._manualDisconnect || this.isConnected) {
          return;
        }

        this.isConnecting = true;
        this._connectionId++;
        const currentConnectionId = this._connectionId;

        try {
          await this._doConnect(currentConnectionId);

          if (this._connectionId !== currentConnectionId) {
            return;
          }

          this.isConnecting = false;
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.emit('reconnected');
          this._startReading();
          this._flushCache();
        } catch (err) {
          this.isConnecting = false;
          this._scheduleReconnect();
        }
      }).catch(() => {
        this._scheduleReconnect();
      });
    }, DEFAULT_RECONNECT_INTERVAL);
  }

  _startReading() {
    this._stopReading();

    this.readTimer = setInterval(() => {
      if (this.port && this.port.isOpen && this.isConnected) {
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
    this._manualDisconnect = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    return this._withLock(async () => {
      this._stopReading();

      const wasConnected = this.isConnected;
      await this._cleanupPort();

      this.isConnected = false;
      this.isConnecting = false;

      if (wasConnected) {
        this.emit('disconnected');
      }

      this._pendingFrameBuffer = null;
      return true;
    });
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      config: { ...this.config },
      reconnectAttempts: this.reconnectAttempts,
      cacheSize: this.offlineCache.length,
      lastReading: this.lastReading,
      connectionId: this._connectionId,
      hasPendingBuffer: this._pendingFrameBuffer && this._pendingFrameBuffer.length > 0
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
