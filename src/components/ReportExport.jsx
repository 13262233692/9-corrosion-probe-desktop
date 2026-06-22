import React, { useState } from 'react';

const api = window.electronAPI;

function ReportExport({ device, devices }) {
  const [timeRange, setTimeRange] = useState('24h');
  const [reportType, setReportType] = useState('pdf');
  const [exporting, setExporting] = useState(false);

  const getTimeRange = (range) => {
    const now = Date.now();
    switch (range) {
      case '24h': return { start: now - 24 * 60 * 60 * 1000, end: now, label: '24小时' };
      case '7d': return { start: now - 7 * 24 * 60 * 60 * 1000, end: now, label: '7天' };
      case '30d': return { start: now - 30 * 24 * 60 * 60 * 1000, end: now, label: '30天' };
      case '90d': return { start: now - 90 * 24 * 60 * 60 * 1000, end: now, label: '90天' };
      default: return { start: now - 24 * 60 * 60 * 1000, end: now, label: '24小时' };
    }
  };

  const handleExport = async () => {
    if (!api || !device) return;
    setExporting(true);

    try {
      const range = getTimeRange(timeRange);
      let result;

      if (reportType === 'pdf') {
        result = await api.report.exportPdf(
          device.device_address,
          range.start,
          range.end
        );
      } else if (reportType === 'csv') {
        result = await api.report.exportCsv(
          device.device_address,
          range.start,
          range.end
        );
      }

      if (result.success) {
        alert(`报告已导出: ${result.data.filePath}`);
      } else if (!result.canceled) {
        alert(`导出失败: ${result.error}`);
      }
    } catch (err) {
      alert(`导出失败: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  const handleInspectionReport = async () => {
    if (!api) return;
    setExporting(true);

    try {
      const range = getTimeRange(timeRange);
      const deviceAddresses = devices.map(d => d.device_address);
      const result = await api.report.inspection(
        'daily',
        deviceAddresses,
        range.start,
        range.end
      );

      if (result.success) {
        console.log('巡检报告数据:', result.data);
        alert('巡检报告生成成功（控制台可查看数据，正式版将导出为PDF）');
      } else {
        alert(`生成失败: ${result.error}`);
      }
    } catch (err) {
      alert(`生成失败: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  const timeRanges = [
    { key: '24h', label: '24小时' },
    { key: '7d', label: '7天' },
    { key: '30d', label: '30天' },
    { key: '90d', label: '90天' }
  ];

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">报告导出</h3>
        </div>

        {!device ? (
          <div className="empty-state">
            <div className="empty-state-icon">📄</div>
            <div className="empty-state-text">请先选择一个设备</div>
          </div>
        ) : (
          <>
            <div className="config-section">
              <h4>当前设备</h4>
              <div className="data-grid">
                <div className="data-item">
                  <div className="label">设备名称</div>
                  <div className="value" style={{ fontSize: 16 }}>{device.name}</div>
                </div>
                <div className="data-item">
                  <div className="label">设备地址</div>
                  <div className="value" style={{ fontSize: 16 }}>{device.device_address}</div>
                </div>
                <div className="data-item">
                  <div className="label">安装位置</div>
                  <div className="value" style={{ fontSize: 16 }}>{device.location || '-'}</div>
                </div>
                <div className="data-item">
                  <div className="label">探针类型</div>
                  <div className="value" style={{ fontSize: 16 }}>{device.probe_type || '-'}</div>
                </div>
              </div>
            </div>

            <div className="config-section">
              <h4>导出设置</h4>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">时间范围</label>
                  <select
                    className="form-select"
                    value={timeRange}
                    onChange={(e) => setTimeRange(e.target.value)}
                  >
                    {timeRanges.map(range => (
                      <option key={range.key} value={range.key}>{range.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">报告格式</label>
                  <select
                    className="form-select"
                    value={reportType}
                    onChange={(e) => setReportType(e.target.value)}
                  >
                    <option value="pdf">PDF 格式</option>
                    <option value="csv">CSV 格式</option>
                  </select>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <button
                className="btn btn-primary btn-lg"
                onClick={handleExport}
                disabled={exporting}
                style={{ flex: 1 }}
              >
                {exporting ? '导出中...' : `导出 ${reportType.toUpperCase()} 报告`}
              </button>
              <button
                className="btn btn-success btn-lg"
                onClick={handleInspectionReport}
                disabled={exporting}
                style={{ flex: 1 }}
              >
                生成巡检报告
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">报告内容说明</h3>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.8, color: '#555' }}>
          <p><strong>PDF 报告包含：</strong></p>
          <ul style={{ paddingLeft: 20, marginBottom: 12 }}>
            <li>设备基本信息</li>
            <li>数据统计汇总</li>
            <li>最近腐蚀速率记录</li>
            <li>报警记录列表</li>
          </ul>
          <p><strong>CSV 报告包含：</strong></p>
          <ul style={{ paddingLeft: 20, marginBottom: 12 }}>
            <li>设备信息</li>
            <li>详细数据记录（电阻、温度、状态）</li>
            <li>腐蚀速率历史</li>
            <li>报警记录</li>
          </ul>
          <p><strong>巡检报告：</strong>汇总所有设备的巡检状态，用于设备科日常巡检记录。</p>
        </div>
      </div>
    </div>
  );
}

export default ReportExport;
