import React, { useEffect, useState } from 'react';

const api = window.electronAPI;

function DeviceStatus({ device, latestReading }) {
  const [corrosionRate, setCorrosionRate] = useState(null);

  useEffect(() => {
    if (!device || !api) return;

    const loadRate = async () => {
      const result = await api.corrosion.getMultiWindow(device.device_address);
      if (result.success && result.data.length > 0) {
        const r24h = result.data.find(r => r.window_hours === 24);
        if (r24h) setCorrosionRate(r24h.rate);
      }
    };

    loadRate();
    const interval = setInterval(loadRate, 60000);
    return () => clearInterval(interval);
  }, [device]);

  if (!device) return null;

  const getRateClass = (rate) => {
    if (!rate) return '';
    if (rate >= device.alarm_threshold * 2) return 'danger';
    if (rate >= device.alarm_threshold) return 'warning';
    return 'success';
  };

  return (
    <div className="sidebar-section">
      <h3>设备状态</h3>
      <div className="data-grid" style={{ gap: 8 }}>
        <div className={`data-item ${getRateClass(corrosionRate)}`} style={{ padding: '10px 12px' }}>
          <div className="label">腐蚀速率</div>
          <div className="value" style={{ fontSize: 16 }}>
            {corrosionRate !== null ? corrosionRate.toFixed(4) : '--'}
            <span className="unit">mm/y</span>
          </div>
        </div>
      </div>

      {latestReading && latestReading.device_address === device.device_address && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>实时数据</div>
          <div style={{ fontSize: 13 }}>
            <div style={{ marginBottom: 4 }}>
              电阻: <strong>{latestReading.resistance?.toFixed(4)}</strong> mΩ
            </div>
            <div>
              温度: <strong>{latestReading.temperature?.toFixed(1)}</strong> °C
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DeviceStatus;
