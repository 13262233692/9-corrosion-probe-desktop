import React, { useState, useEffect } from 'react';

const api = window.electronAPI;

function ConfigPanel({ onStatusChange, connectionStatus }) {
  const [ports, setPorts] = useState([]);
  const [config, setConfig] = useState({
    path: '',
    baudRate: 9600,
    deviceAddress: 1,
    sampleInterval: 1000
  });
  const [isScanning, setIsScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const baudRates = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
  const sampleIntervals = [
    { value: 500, label: '500ms' },
    { value: 1000, label: '1秒' },
    { value: 2000, label: '2秒' },
    { value: 5000, label: '5秒' },
    { value: 10000, label: '10秒' },
    { value: 30000, label: '30秒' },
    { value: 60000, label: '1分钟' }
  ];

  const scanPorts = async () => {
    if (!api) return;
    setIsScanning(true);
    const result = await api.serial.listPorts();
    if (result.success) {
      setPorts(result.data);
    }
    setIsScanning(false);
  };

  useEffect(() => {
    scanPorts();
  }, []);

  useEffect(() => {
    const loadConfig = async () => {
      if (!api) return;
      const result = await api.config.get('serial_config', null);
      if (result.success && result.data) {
        setConfig(prev => ({ ...prev, ...result.data }));
      }
    };
    loadConfig();
  }, []);

  const handleConnect = async () => {
    if (!api) return;
    setConnecting(true);
    const result = await api.serial.connect(config);
    if (result.success) {
      await api.config.set('serial_config', config);
    } else {
      alert(`连接失败: ${result.error}`);
    }
    setConnecting(false);
    if (onStatusChange) onStatusChange();
  };

  const handleDisconnect = async () => {
    if (!api) return;
    const result = await api.serial.disconnect();
    if (result.success) {
      if (onStatusChange) onStatusChange();
    }
  };

  const handleUpdateInterval = async () => {
    if (!api) return;
    await api.serial.updateInterval(config.sampleInterval);
    await api.config.set('serial_config', config);
  };

  const isConnected = connectionStatus === 'connected';
  const isConnecting = connectionStatus === 'connecting';

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">串口配置</h3>
        </div>

        <div className="config-section">
          <h4>连接设置</h4>

          <div className="form-group">
            <label className="form-label">串口号</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                className="form-select"
                value={config.path}
                onChange={(e) => setConfig(prev => ({ ...prev, path: e.target.value }))}
                disabled={isConnected}
                style={{ flex: 1 }}
              >
                <option value="">请选择串口</option>
                {ports.map(port => (
                  <option key={port.path} value={port.path}>
                    {port.path} {port.manufacturer ? `(${port.manufacturer})` : ''}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-default"
                onClick={scanPorts}
                disabled={isScanning || isConnected}
              >
                {isScanning ? '扫描中...' : '扫描串口'}
              </button>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">波特率</label>
              <select
                className="form-select"
                value={config.baudRate}
                onChange={(e) => setConfig(prev => ({ ...prev, baudRate: Number(e.target.value) }))}
                disabled={isConnected}
              >
                {baudRates.map(rate => (
                  <option key={rate} value={rate}>{rate} bps</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">设备地址</label>
              <input
                type="number"
                className="form-input"
                value={config.deviceAddress}
                onChange={(e) => setConfig(prev => ({ ...prev, deviceAddress: Number(e.target.value) }))}
                min="1"
                max="255"
                disabled={isConnected}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">采样间隔</label>
            <select
              className="form-select"
              value={config.sampleInterval}
              onChange={(e) => setConfig(prev => ({ ...prev, sampleInterval: Number(e.target.value) }))}
            >
              {sampleIntervals.map(interval => (
                <option key={interval.value} value={interval.value}>{interval.label}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            {!isConnected ? (
              <button
                className="btn btn-primary btn-lg"
                onClick={handleConnect}
                disabled={!config.path || isConnecting || connecting}
                style={{ flex: 1 }}
              >
                {isConnecting || connecting ? '连接中...' : '连接设备'}
              </button>
            ) : (
              <>
                <button
                  className="btn btn-danger"
                  onClick={handleDisconnect}
                >
                  断开连接
                </button>
                <button
                  className="btn btn-default"
                  onClick={handleUpdateInterval}
                >
                  更新采样间隔
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">连接状态</h3>
        </div>
        <div className="data-grid">
          <div className={`data-item ${isConnected ? 'success' : 'danger'}`}>
            <div className="label">连接状态</div>
            <div className="value">
              {isConnected ? '已连接' : isConnecting ? '连接中' : '未连接'}
            </div>
          </div>
          <div className="data-item">
            <div className="label">串口号</div>
            <div className="value" style={{ fontSize: 16 }}>
              {config.path || '--'}
            </div>
          </div>
          <div className="data-item">
            <div className="label">波特率</div>
            <div className="value" style={{ fontSize: 16 }}>
              {config.baudRate} bps
            </div>
          </div>
          <div className="data-item">
            <div className="label">采样间隔</div>
            <div className="value" style={{ fontSize: 16 }}>
              {config.sampleInterval} ms
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">协议说明</h3>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.8, color: '#555' }}>
          <p><strong>帧结构：</strong></p>
          <ul style={{ paddingLeft: 20, marginBottom: 12 }}>
            <li>帧头: 2字节 (0xAA 0x55)</li>
            <li>设备地址: 1字节</li>
            <li>测量电阻: 4字节 (float, 单位: mΩ)</li>
            <li>温度: 2字节 (int16, 单位: 0.1°C)</li>
            <li>时间戳: 4字节 (uint32, Unix时间戳)</li>
            <li>状态位: 1字节</li>
            <li>CRC校验: 2字节 (CRC16-Modbus)</li>
            <li>帧尾: 2字节 (0x0D 0x0A)</li>
          </ul>
          <p><strong>状态位定义：</strong></p>
          <ul style={{ paddingLeft: 20 }}>
            <li>Bit 0: 探针正常 (0=正常, 1=故障)</li>
            <li>Bit 1: 超温报警</li>
            <li>Bit 2: 低电量</li>
            <li>Bit 3: 通信错误</li>
            <li>Bit 4: 传感器报警</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default ConfigPanel;
