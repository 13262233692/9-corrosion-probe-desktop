import React, { useState, useEffect, useCallback } from 'react';
import RealTimeChart from './components/RealTimeChart';
import HistoryTrend from './components/HistoryTrend';
import AlarmList from './components/AlarmList';
import ConfigPanel from './components/ConfigPanel';
import DeviceManager from './components/DeviceManager';
import ReportExport from './components/ReportExport';
import DeviceStatus from './components/DeviceStatus';

const api = window.electronAPI;

function App() {
  const [activeTab, setActiveTab] = useState('realtime');
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [serialConfig, setSerialConfig] = useState(null);
  const [unacknowledgedCount, setUnacknowledgedCount] = useState(0);
  const [latestReading, setLatestReading] = useState(null);

  const loadDevices = useCallback(async () => {
    if (!api) return;
    const result = await api.device.list();
    if (result.success) {
      setDevices(result.data);
      if (result.data.length > 0 && !selectedDevice) {
        setSelectedDevice(result.data[0]);
      }
    }
  }, [selectedDevice]);

  const loadSerialStatus = useCallback(async () => {
    if (!api) return;
    const result = await api.serial.getStatus();
    if (result.success) {
      const status = result.data;
      if (status.isConnecting) {
        setConnectionStatus('connecting');
      } else if (status.isConnected) {
        setConnectionStatus('connected');
      } else {
        setConnectionStatus('disconnected');
      }
      setSerialConfig(status.config);
    }
  }, []);

  const loadUnacknowledged = useCallback(async () => {
    if (!api) return;
    const result = await api.alarm.unacknowledged();
    if (result.success) {
      setUnacknowledgedCount(result.data.length);
    }
  }, []);

  useEffect(() => {
    loadDevices();
    loadSerialStatus();
    loadUnacknowledged();
  }, [loadDevices, loadSerialStatus, loadUnacknowledged]);

  useEffect(() => {
    if (!api) return;

    const unsubConnect = api.serial.onConnected(() => {
      setConnectionStatus('connected');
    });
    const unsubDisconnect = api.serial.onDisconnected(() => {
      setConnectionStatus('disconnected');
    });
    const unsubReconnecting = api.serial.onReconnecting(() => {
      setConnectionStatus('connecting');
    });
    const unsubReconnected = api.serial.onReconnected(() => {
      setConnectionStatus('connected');
    });
    const unsubReading = api.serial.onReading((reading) => {
      setLatestReading(reading);
    });
    const unsubAlarm = api.alarm.onNewAlarm(() => {
      loadUnacknowledged();
    });

    return () => {
      if (unsubConnect) unsubConnect();
      if (unsubDisconnect) unsubDisconnect();
      if (unsubReconnecting) unsubReconnecting();
      if (unsubReconnected) unsubReconnected();
      if (unsubReading) unsubReading();
      if (unsubAlarm) unsubAlarm();
    };
  }, [loadUnacknowledged]);

  const statusText = {
    connected: '已连接',
    disconnected: '未连接',
    connecting: '连接中...'
  };

  const tabs = [
    { key: 'realtime', label: '实时监控' },
    { key: 'history', label: '历史趋势' },
    { key: 'alarms', label: `报警列表${unacknowledgedCount > 0 ? ` (${unacknowledgedCount})` : ''}` },
    { key: 'devices', label: '设备管理' },
    { key: 'report', label: '报告导出' },
    { key: 'config', label: '系统配置' }
  ];

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>
          <span>⚙️</span>
          腐蚀探针数据采集系统
        </h1>
        <div className="status-indicator">
          <span className={`status-dot ${connectionStatus}`}></span>
          <span>{statusText[connectionStatus]}</span>
          {serialConfig && (
            <span style={{ opacity: 0.7, marginLeft: 8 }}>
              {serialConfig.path} @ {serialConfig.baudRate}bps
            </span>
          )}
        </div>
      </header>

      <div className="app-main">
        <aside className="sidebar">
          <div className="sidebar-section">
            <h3>设备列表</h3>
            <ul className="device-list">
              {devices.map((device) => (
                <li
                  key={device.device_address}
                  className={`device-item ${selectedDevice?.device_address === device.device_address ? 'active' : ''}`}
                  onClick={() => setSelectedDevice(device)}
                >
                  <div>
                    <div className="device-name">{device.name}</div>
                    <div className="device-addr">地址: {device.device_address}</div>
                  </div>
                </li>
              ))}
              {devices.length === 0 && (
                <li style={{ color: '#999', fontSize: 12, padding: '8px 0' }}>
                  暂无设备，请先添加
                </li>
              )}
            </ul>
          </div>

          {selectedDevice && (
            <DeviceStatus device={selectedDevice} latestReading={latestReading} />
          )}
        </aside>

        <main className="content-area">
          <div className="content-tabs">
            {tabs.map((tab) => (
              <div
                key={tab.key}
                className={`tab-item ${activeTab === tab.key ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </div>
            ))}
          </div>

          <div className="tab-content">
            {activeTab === 'realtime' && (
              <RealTimeChart device={selectedDevice} />
            )}
            {activeTab === 'history' && (
              <HistoryTrend device={selectedDevice} />
            )}
            {activeTab === 'alarms' && (
              <AlarmList onAcknowledge={loadUnacknowledged} />
            )}
            {activeTab === 'devices' && (
              <DeviceManager onDevicesChange={loadDevices} />
            )}
            {activeTab === 'report' && (
              <ReportExport device={selectedDevice} devices={devices} />
            )}
            {activeTab === 'config' && (
              <ConfigPanel
                onStatusChange={loadSerialStatus}
                connectionStatus={connectionStatus}
              />
            )}
          </div>
        </main>
      </div>

      <footer className="status-bar">
        <div className="status-bar-left">
          <span className="status-bar-item">
            设备数: {devices.length}
          </span>
          {selectedDevice && (
            <span className="status-bar-item">
              当前设备: {selectedDevice.name}
            </span>
          )}
        </div>
        <div className="status-bar-right">
          <span className="status-bar-item">
            未确认报警: {unacknowledgedCount}
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
