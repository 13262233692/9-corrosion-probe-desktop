import React, { useEffect, useState } from 'react';
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

const COLOR_PALETTE = [
  { border: '#3498db', bg: 'rgba(52, 152, 219, 0.08)' },
  { border: '#e74c3c', bg: 'rgba(231, 76, 60, 0.08)' },
  { border: '#2ecc71', bg: 'rgba(46, 204, 113, 0.08)' },
  { border: '#f39c12', bg: 'rgba(243, 156, 18, 0.08)' },
  { border: '#9b59b6', bg: 'rgba(155, 89, 182, 0.08)' },
  { border: '#1abc9c', bg: 'rgba(26, 188, 156, 0.08)' },
  { border: '#e67e22', bg: 'rgba(230, 126, 34, 0.08)' },
  { border: '#34495e', bg: 'rgba(52, 73, 94, 0.08)' }
];

const PRESET_HOURS = [6, 24, 72, 168];

function MultiCompareView() {
  const [devices, setDevices] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedAddresses, setSelectedAddresses] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [rangeHours, setRangeHours] = useState(24);
  const [intervalHours, setIntervalHours] = useState(1);
  const [loading, setLoading] = useState(false);
  const [trendData, setTrendData] = useState([]);
  const [rateData, setRateData] = useState([]);
  const [report, setReport] = useState(null);
  const [alarms, setAlarms] = useState([]);
  const [newGroupAlarms, setNewGroupAlarms] = useState([]);

  useEffect(() => {
    loadData();
    loadGroups();
  }, []);

  useEffect(() => {
    if (!api?.comparison?.onNewGroupAlarm) return;
    const unsub = api.comparison.onNewGroupAlarm((newAlarms) => {
      setNewGroupAlarms(prev => [...newAlarms, ...prev].slice(0, 20));
    });
    return () => { if (unsub) unsub(); };
  }, []);

  useEffect(() => {
    if (selectedAddresses.length > 0) {
      loadComparison();
    } else {
      setTrendData([]);
      setRateData([]);
      setReport(null);
    }
  }, [selectedAddresses, rangeHours, intervalHours]);

  const loadData = async () => {
    if (!api?.device?.list) return;
    const res = await api.device.list();
    if (res.success) setDevices(res.data);
  };

  const loadGroups = async () => {
    if (!api?.group?.list) return;
    const res = await api.group.list();
    if (res.success) setGroups(res.data);
  };

  const loadComparison = async () => {
    if (!api?.comparison || selectedAddresses.length === 0) return;
    setLoading(true);
    try {
      const now = Date.now();
      const startTime = now - rangeHours * 60 * 60 * 1000;

      const [trendRes, rateRes, reportRes] = await Promise.all([
        api.comparison.getTrends(selectedAddresses, startTime, now, { intervalHours }),
        api.comparison.getRates(selectedAddresses, { windowHours: rangeHours }),
        api.comparison.getReport(selectedAddresses, { windowHours: rangeHours })
      ]);

      if (trendRes.success) setTrendData(trendRes.data);
      if (rateRes.success) setRateData(rateRes.data);
      if (reportRes.success) setReport(reportRes.data);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectDevice = (addr) => {
    setSelectedAddresses(prev =>
      prev.includes(addr)
        ? prev.filter(a => a !== addr)
        : [...prev, addr]
    );
  };

  const handleSelectGroup = (groupId) => {
    setSelectedGroupId(groupId);
    if (groupId) {
      const g = groups.find(x => x.id === groupId);
      if (g) setSelectedAddresses(g.device_addresses);
    } else {
      setSelectedAddresses([]);
    }
  };

  const handleExport = async (format) => {
    if (!api?.reportExtra?.exportComparison) return;
    await api.reportExtra.exportComparison(selectedAddresses, {
      format,
      windowHours: rangeHours
    });
  };

  const getColor = (idx) => COLOR_PALETTE[idx % COLOR_PALETTE.length];

  const buildRateChart = () => {
    const labels = trendData.length > 0
      ? (trendData[0]?.points || []).map(p => {
        const d = new Date(p.timestamp);
        return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit' });
      })
      : [];

    const datasets = trendData.map((series, idx) => {
      const color = getColor(idx);
      return {
        label: series.device_name,
        data: (series.points || []).map(p => p.rate),
        borderColor: color.border,
        backgroundColor: color.bg,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2
      };
    });

    return { labels, datasets };
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } }
      },
      tooltip: {
        mode: 'index',
        intersect: false
      }
    },
    scales: {
      x: {
        display: true,
        ticks: { maxTicksLimit: 10, font: { size: 10 } }
      },
      y: {
        display: true,
        title: { display: true, text: '腐蚀速率 (mm/y)', font: { size: 11 } },
        ticks: { font: { size: 10 } }
      }
    },
    interaction: { mode: 'nearest', axis: 'x', intersect: false }
  };

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3 className="card-title">多设备对比设置</h3>
        </div>
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={{ flex: '1 1 280px', minWidth: 280 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#444' }}>
                选择分组
              </div>
              <select
                className="form-input"
                value={selectedGroupId || ''}
                onChange={(e) => handleSelectGroup(e.target.value ? Number(e.target.value) : null)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ddd' }}
              >
                <option value="">-- 手动选择设备 --</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.device_addresses?.length || 0}台)
                  </option>
                ))}
              </select>
            </div>

            <div style={{ flex: '1 1 160px', minWidth: 160 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#444' }}>
                时间范围
              </div>
              <select
                className="form-input"
                value={rangeHours}
                onChange={(e) => setRangeHours(Number(e.target.value))}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ddd' }}
              >
                {PRESET_HOURS.map(h => (
                  <option key={h} value={h}>
                    {h < 24 ? `${h}小时` : `${h / 24}天`}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ flex: '1 1 160px', minWidth: 160 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#444' }}>
                采样间隔
              </div>
              <select
                className="form-input"
                value={intervalHours}
                onChange={(e) => setIntervalHours(Number(e.target.value))}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ddd' }}
              >
                <option value={1}>1小时</option>
                <option value={3}>3小时</option>
                <option value={6}>6小时</option>
                <option value={12}>12小时</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={loadComparison}
                disabled={selectedAddresses.length === 0}
                style={{ padding: '8px 16px' }}
              >
                刷新对比
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => handleExport('pdf')}
                disabled={selectedAddresses.length === 0}
                style={{ padding: '8px 16px' }}
              >
                导出PDF
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => handleExport('csv')}
                disabled={selectedAddresses.length === 0}
                style={{ padding: '8px 16px' }}
              >
                导出CSV
              </button>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#444' }}>
              参与对比设备 ({selectedAddresses.length}/{devices.length})
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {devices.map((d, idx) => {
                const checked = selectedAddresses.includes(d.device_address);
                const color = getColor(idx);
                return (
                  <label
                    key={d.device_address}
                    className={`device-chip ${checked ? 'active' : ''}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 12px',
                      borderRadius: 999,
                      border: checked
                        ? `2px solid ${color.border}`
                        : '1px solid #ddd',
                      background: checked ? color.bg : '#fff',
                      cursor: 'pointer',
                      fontSize: 13,
                      userSelect: 'none'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleSelectDevice(d.device_address)}
                      style={{ margin: 0 }}
                    />
                    <span style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: color.border
                    }} />
                    {d.name}
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {rateData.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <h3 className="card-title">{rangeHours}小时窗口速率对比</h3>
          </div>
          <div style={{ padding: '0 16px 16px' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(200px, 1fr))`,
              gap: 12
            }}>
              {rateData.map((r, idx) => {
                const color = getColor(idx);
                const invalid = r.error || r.sample_count < 2;
                return (
                  <div key={r.device_address} style={{
                    padding: 12,
                    borderRadius: 8,
                    background: invalid ? '#fafafa' : color.bg,
                    border: `1px solid ${invalid ? '#eee' : color.border}`,
                    opacity: invalid ? 0.6 : 1
                  }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: 6,
                      fontWeight: 600,
                      fontSize: 13
                    }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%', background: color.border
                      }} />
                      {r.device_name}
                    </div>
                    <div style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: invalid ? '#999' : '#333'
                    }}>
                      {r.rate?.toFixed?.(4) || '0.0000'}
                      <span style={{ fontSize: 12, fontWeight: 400, color: '#888', marginLeft: 4 }}>
                        mm/y
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: invalid ? '#e74c3c' : '#888', marginTop: 4 }}>
                      {r.sample_count || 0} 样本
                      {r.error ? ` · ${r.error}` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {selectedAddresses.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-state-icon">📈</div>
          <div className="empty-state-text">请选择至少一个设备进行对比分析</div>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">
              <h3 className="card-title">腐蚀速率趋势对比</h3>
              {loading && <span style={{ fontSize: 12, color: '#888' }}>加载中...</span>}
            </div>
            <div style={{ height: 360, padding: '0 16px 16px' }}>
              <Line data={buildRateChart()} options={chartOptions} />
            </div>
          </div>

          {report && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header">
                <h3 className="card-title">对比分析结论</h3>
              </div>
              <div style={{ padding: '0 16px 16px' }}>
                {report.summary && (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(auto-fill, minmax(180px, 1fr))`,
                    gap: 12,
                    marginBottom: 16
                  }}>
                    <div style={{
                      padding: 12, borderRadius: 8, background: '#f8f9fa', border: '1px solid #eee'
                    }}>
                      <div style={{ fontSize: 12, color: '#888' }}>有效设备</div>
                      <div style={{ fontSize: 20, fontWeight: 700 }}>
                        {report.summary.valid_devices}/{report.summary.total_devices}
                      </div>
                    </div>
                    <div style={{
                      padding: 12, borderRadius: 8, background: '#f8f9fa', border: '1px solid #eee'
                    }}>
                      <div style={{ fontSize: 12, color: '#888' }}>平均速率</div>
                      <div style={{ fontSize: 20, fontWeight: 700 }}>
                        {report.summary.mean_rate?.toFixed?.(4) || '--'}
                        <span style={{ fontSize: 12, fontWeight: 400, color: '#888' }}> mm/y</span>
                      </div>
                    </div>
                    <div style={{
                      padding: 12, borderRadius: 8, background: '#f8f9fa', border: '1px solid #eee'
                    }}>
                      <div style={{ fontSize: 12, color: '#888' }}>最大偏差率</div>
                      <div style={{
                        fontSize: 20,
                        fontWeight: 700,
                        color: (report.summary.max_deviation_ratio || 0) > 0.5 ? '#e74c3c' : '#333'
                      }}>
                        {(report.summary.max_deviation_ratio * 100)?.toFixed?.(0) || 0}%
                      </div>
                    </div>
                    <div style={{
                      padding: 12, borderRadius: 8, background: '#f8f9fa', border: '1px solid #eee'
                    }}>
                      <div style={{ fontSize: 12, color: '#888' }}>超阈值设备</div>
                      <div style={{
                        fontSize: 20,
                        fontWeight: 700,
                        color: report.summary.over_threshold_count > 0 ? '#e74c3c' : '#2ecc71'
                      }}>
                        {report.summary.over_threshold_count || 0} 台
                      </div>
                    </div>
                  </div>
                )}

                <div style={{
                  padding: 14,
                  background: '#fffbeb',
                  borderRadius: 8,
                  borderLeft: '4px solid #f59e0b'
                }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: '#92400e' }}>
                    📋 分析结论
                  </div>
                  {(report.conclusions || [report.conclusion]).map((c, i) => (
                    <div key={i} style={{ fontSize: 13, lineHeight: 1.6, color: '#78350f', marginBottom: 4 }}>
                      • {c}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {newGroupAlarms.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">
                  最近组预警 ({newGroupAlarms.length})
                </h3>
              </div>
              <div style={{ padding: '0 16px 16px' }}>
                {newGroupAlarms.map((a, i) => (
                  <div key={i} style={{
                    padding: 10,
                    borderRadius: 6,
                    background: a.level === 'critical' ? '#fef2f2'
                      : a.level === 'warning' ? '#fffbeb' : '#eff6ff',
                    marginBottom: 8,
                    fontSize: 13,
                    borderLeft: `3px solid ${
                      a.level === 'critical' ? '#dc2626'
                        : a.level === 'warning' ? '#d97706' : '#2563eb'
                    }`
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>
                      [{a.rule_type || 'group'}] {a.group_name || a.device_name || ''}
                    </div>
                    <div>{a.message}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default MultiCompareView;
