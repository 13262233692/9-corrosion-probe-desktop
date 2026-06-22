import React, { useState, useEffect } from 'react';
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

function HistoryTrend({ device }) {
  const [timeRange, setTimeRange] = useState('24h');
  const [readings, setReadings] = useState([]);
  const [rateTrend, setRateTrend] = useState([]);
  const [loading, setLoading] = useState(false);

  const getTimeRange = (range) => {
    const now = Date.now();
    switch (range) {
      case '1h': return { start: now - 1 * 60 * 60 * 1000, end: now, interval: 5 };
      case '6h': return { start: now - 6 * 60 * 60 * 1000, end: now, interval: 15 };
      case '24h': return { start: now - 24 * 60 * 60 * 1000, end: now, interval: 60 };
      case '7d': return { start: now - 7 * 24 * 60 * 60 * 1000, end: now, interval: 360 };
      case '30d': return { start: now - 30 * 24 * 60 * 60 * 1000, end: now, interval: 1440 };
      default: return { start: now - 24 * 60 * 60 * 1000, end: now, interval: 60 };
    }
  };

  useEffect(() => {
    if (!device || !api) return;

    const loadData = async () => {
      setLoading(true);
      const range = getTimeRange(timeRange);

      const [readingResult, trendResult] = await Promise.all([
        api.readings.range(device.device_address, range.start, range.end),
        api.corrosion.getTrend(device.device_address, range.start, range.end, 24)
      ]);

      if (readingResult.success) {
        setReadings(readingResult.data);
      }

      if (trendResult.success) {
        setRateTrend(trendResult.data);
      }

      setLoading(false);
    };

    loadData();
  }, [device, timeRange]);

  const formatTime = (timestamp) => {
    const d = new Date(timestamp);
    const range = getTimeRange(timeRange);
    const diffMs = range.end - range.start;

    if (diffMs <= 24 * 60 * 60 * 1000) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } else if (diffMs <= 7 * 24 * 60 * 60 * 1000) {
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
    } else {
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }
  };

  const resistanceData = {
    labels: readings.map(r => formatTime(r.timestamp)),
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

  const rateData = {
    labels: rateTrend.map(r => formatTime(r.timestamp)),
    datasets: [
      {
        label: '腐蚀速率 (mm/y)',
        data: rateTrend.map(r => r.rate),
        borderColor: '#e74c3c',
        backgroundColor: 'rgba(231, 76, 60, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        borderWidth: 2
      },
      {
        label: '报警阈值',
        data: rateTrend.map(() => device?.alarm_threshold || 0.5),
        borderColor: '#95a5a6',
        borderDash: [5, 5],
        pointRadius: 0,
        borderWidth: 1,
        fill: false
      }
    ]
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
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
          maxTicksLimit: 10
        }
      },
      y: {
        display: true
      }
    }
  };

  const timeRanges = [
    { key: '1h', label: '1小时' },
    { key: '6h', label: '6小时' },
    { key: '24h', label: '24小时' },
    { key: '7d', label: '7天' },
    { key: '30d', label: '30天' }
  ];

  return (
    <div>
      {!device ? (
        <div className="empty-state">
          <div className="empty-state-icon">📈</div>
          <div className="empty-state-text">请选择一个设备查看历史趋势</div>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">历史趋势</h3>
              <div style={{ display: 'flex', gap: 6 }}>
                {timeRanges.map(range => (
                  <button
                    key={range.key}
                    className={`btn btn-sm ${timeRange === range.key ? 'btn-primary' : 'btn-default'}`}
                    onClick={() => setTimeRange(range.key)}
                  >
                    {range.label}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <div className="empty-state">
                <div className="empty-state-text">加载中...</div>
              </div>
            ) : (
              <>
                <div className="chart-container" style={{ height: 280, marginBottom: 20 }}>
                  <Line data={resistanceData} options={chartOptions} />
                </div>

                <div className="chart-container" style={{ height: 280 }}>
                  <Line data={rateData} options={chartOptions} />
                </div>
              </>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">数据统计</h3>
            </div>
            <div className="data-grid">
              <div className="data-item">
                <div className="label">数据总数</div>
                <div className="value">
                  {readings.length}
                  <span className="unit">条</span>
                </div>
              </div>
              <div className="data-item">
                <div className="label">平均电阻</div>
                <div className="value">
                  {readings.length > 0
                    ? (readings.reduce((s, r) => s + r.resistance, 0) / readings.length).toFixed(4)
                    : '--'}
                  <span className="unit">mΩ</span>
                </div>
              </div>
              <div className="data-item">
                <div className="label">平均温度</div>
                <div className="value">
                  {readings.length > 0
                    ? (readings.reduce((s, r) => s + r.temperature, 0) / readings.length).toFixed(1)
                    : '--'}
                  <span className="unit">°C</span>
                </div>
              </div>
              <div className="data-item">
                <div className="label">最新速率</div>
                <div className="value">
                  {rateTrend.length > 0 ? rateTrend[rateTrend.length - 1].rate?.toFixed(4) : '--'}
                  <span className="unit">mm/y</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default HistoryTrend;
