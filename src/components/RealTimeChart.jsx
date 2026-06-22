import React, { useEffect, useRef, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const api = window.electronAPI;
const MAX_POINTS = 100;

function RealTimeChart({ device }) {
  const [readings, setReadings] = useState([]);
  const [corrosionRates, setCorrosionRates] = useState([]);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!device || !api) return;

    const loadInitial = async () => {
      const result = await api.readings.list(device.device_address, MAX_POINTS, 0);
      if (result.success) {
        const sorted = [...result.data].reverse();
        setReadings(sorted.slice(-MAX_POINTS));
      }

      const rateResult = await api.corrosion.getMultiWindow(device.device_address);
      if (rateResult.success) {
        setCorrosionRates(rateResult.data);
      }
    };

    loadInitial();
  }, [device]);

  useEffect(() => {
    if (!device || !api) return;

    const unsub = api.serial.onReading((reading) => {
      if (reading.device_address === device.device_address) {
        setReadings(prev => {
          const newReadings = [...prev, reading];
          return newReadings.slice(-MAX_POINTS);
        });
      }
    });

    return () => {
      if (unsub) unsub();
    };
  }, [device]);

  useEffect(() => {
    if (!device || !api) return;

    const loadRates = async () => {
      const result = await api.corrosion.getMultiWindow(device.device_address);
      if (result.success) {
        setCorrosionRates(result.data);
      }
    };

    const interval = setInterval(loadRates, 30000);
    return () => clearInterval(interval);
  }, [device]);

  const resistanceData = {
    labels: readings.map(r => {
      const d = new Date(r.timestamp);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }),
    datasets: [
      {
        label: '电阻 (mΩ)',
        data: readings.map(r => r.resistance),
        borderColor: '#3498db',
        backgroundColor: 'rgba(52, 152, 219, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2
      }
    ]
  };

  const temperatureData = {
    labels: readings.map(r => {
      const d = new Date(r.timestamp);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }),
    datasets: [
      {
        label: '温度 (°C)',
        data: readings.map(r => r.temperature),
        borderColor: '#e67e22',
        backgroundColor: 'rgba(230, 126, 34, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2
      }
    ]
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 0
    },
    plugins: {
      legend: {
        display: true,
        position: 'top'
      },
      tooltip: {
        mode: 'index',
        intersect: false
      }
    },
    scales: {
      x: {
        display: true,
        ticks: {
          maxTicksLimit: 8,
          fontSize: 11
        }
      },
      y: {
        display: true
      }
    },
    interaction: {
      mode: 'nearest',
      axis: 'x',
      intersect: false
    }
  };

  const latest = readings.length > 0 ? readings[readings.length - 1] : null;

  return (
    <div>
      {!device ? (
        <div className="empty-state">
          <div className="empty-state-icon">📊</div>
          <div className="empty-state-text">请选择一个设备查看实时数据</div>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">实时数据概览</h3>
            </div>
            <div className="data-grid">
              <div className="data-item">
                <div className="label">当前电阻</div>
                <div className="value">
                  {latest ? latest.resistance?.toFixed(4) : '--'}
                  <span className="unit">mΩ</span>
                </div>
              </div>
              <div className="data-item">
                <div className="label">当前温度</div>
                <div className="value">
                  {latest ? latest.temperature?.toFixed(1) : '--'}
                  <span className="unit">°C</span>
                </div>
              </div>
              <div className="data-item success">
                <div className="label">24h腐蚀速率</div>
                <div className="value">
                  {corrosionRates.find(r => r.window_hours === 24)?.rate?.toFixed(4) || '--'}
                  <span className="unit">mm/y</span>
                </div>
              </div>
              <div className="data-item">
                <div className="label">数据点数</div>
                <div className="value">
                  {readings.length}
                  <span className="unit">点</span>
                </div>
              </div>
            </div>
          </div>

          <div className="realtime-grid">
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">电阻变化曲线</h3>
              </div>
              <div className="chart-container">
                <Line data={resistanceData} options={chartOptions} ref={chartRef} />
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3 className="card-title">温度变化曲线</h3>
              </div>
              <div className="chart-container">
                <Line data={temperatureData} options={chartOptions} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">多窗口腐蚀速率</h3>
            </div>
            <div className="rate-grid">
              {corrosionRates.map((rate, index) => {
                const isHigh = rate.rate >= (device.alarm_threshold || 0.5);
                const isMedium = rate.rate >= (device.alarm_threshold || 0.5) * 0.7;
                const rateClass = isHigh ? 'high' : isMedium ? 'medium' : '';
                return (
                  <div key={index} className={`rate-card ${rateClass}`}>
                    <div className="window">{rate.window_label}</div>
                    <div className="rate-value">{rate.rate?.toFixed(4) || '--'}</div>
                    <div className="rate-unit">mm/y</div>
                    <div style={{ fontSize: 10, color: '#999', marginTop: 4 }}>
                      {rate.sample_count || 0} 样本
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default RealTimeChart;
