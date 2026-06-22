import React, { useState, useEffect, useCallback } from 'react';

const api = window.electronAPI;

const ALARM_TYPE_NAMES = {
  high_corrosion_rate: '腐蚀速率超标',
  crc_error: 'CRC校验错误',
  device_disconnected: '设备断开连接',
  timestamp_reverse: '时间戳倒退',
  temperature_abnormal: '温度异常',
  resistance_abnormal: '电阻异常',
  probe_fault: '探针故障',
  low_battery: '电池电量低'
};

const ALARM_LEVEL_NAMES = {
  critical: '严重',
  warning: '警告',
  info: '提示'
};

function AlarmList({ onAcknowledge }) {
  const [alarms, setAlarms] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(false);

  const loadAlarms = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    const result = await api.alarm.list(200, 0);
    if (result.success) {
      setAlarms(result.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAlarms();
  }, [loadAlarms]);

  useEffect(() => {
    if (!api) return;

    const unsub = api.alarm.onNewAlarm((newAlarms) => {
      setAlarms(prev => [...newAlarms, ...prev].slice(0, 200));
    });

    return () => {
      if (unsub) unsub();
    };
  }, []);

  const handleAcknowledge = async (id) => {
    if (!api) return;
    const result = await api.alarm.acknowledge(id);
    if (result.success) {
      loadAlarms();
      if (onAcknowledge) onAcknowledge();
    }
  };

  const handleAcknowledgeAll = async () => {
    if (!api) return;
    const unacknowledged = alarms.filter(a => !a.acknowledged);
    for (const alarm of unacknowledged) {
      await api.alarm.acknowledge(alarm.id);
    }
    loadAlarms();
    if (onAcknowledge) onAcknowledge();
  };

  const filteredAlarms = alarms.filter(alarm => {
    if (filter === 'all') return true;
    if (filter === 'unacknowledged') return !alarm.acknowledged;
    if (filter === 'critical') return alarm.level === 'critical';
    if (filter === 'warning') return alarm.level === 'warning';
    if (filter === 'info') return alarm.level === 'info';
    return true;
  });

  const filters = [
    { key: 'all', label: '全部' },
    { key: 'unacknowledged', label: '未确认' },
    { key: 'critical', label: '严重' },
    { key: 'warning', label: '警告' },
    { key: 'info', label: '提示' }
  ];

  const getBadgeClass = (level) => {
    switch (level) {
      case 'critical': return 'badge-danger';
      case 'warning': return 'badge-warning';
      case 'info': return 'badge-info';
      default: return 'badge-info';
    }
  };

  const getAlarmItemClass = (alarm) => {
    let cls = `alarm-item ${alarm.level}`;
    if (alarm.acknowledged) cls += ' acknowledged';
    return cls;
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleString('zh-CN');
  };

  const unacknowledgedCount = alarms.filter(a => !a.acknowledged).length;

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">
          报警列表
          {unacknowledgedCount > 0 && (
            <span className="badge badge-danger" style={{ marginLeft: 8 }}>
              {unacknowledgedCount} 未确认
            </span>
          )}
        </h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {filters.map(f => (
              <button
                key={f.key}
                className={`btn btn-sm ${filter === f.key ? 'btn-primary' : 'btn-default'}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            className="btn btn-sm btn-default"
            onClick={loadAlarms}
          >
            刷新
          </button>
          {unacknowledgedCount > 0 && (
            <button
              className="btn btn-sm btn-success"
              onClick={handleAcknowledgeAll}
            >
              全部确认
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="empty-state">
          <div className="empty-state-text">加载中...</div>
        </div>
      ) : filteredAlarms.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🔔</div>
          <div className="empty-state-text">暂无报警记录</div>
        </div>
      ) : (
        <div style={{ maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' }}>
          {filteredAlarms.map(alarm => (
            <div key={alarm.id} className={getAlarmItemClass(alarm)}>
              <div className="alarm-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`badge ${getBadgeClass(alarm.level)}`}>
                    {ALARM_LEVEL_NAMES[alarm.level] || alarm.level}
                  </span>
                  <span className="alarm-type">
                    {ALARM_TYPE_NAMES[alarm.alarm_type] || alarm.alarm_type}
                  </span>
                  {alarm.device_name && (
                    <span style={{ fontSize: 12, color: '#888' }}>
                      [{alarm.device_name}]
                    </span>
                  )}
                </div>
                <span className="alarm-time">{formatTime(alarm.created_at)}</span>
              </div>
              <div className="alarm-message">{alarm.message}</div>
              {!alarm.acknowledged && (
                <div className="alarm-actions">
                  <button
                    className="btn btn-sm btn-default"
                    onClick={() => handleAcknowledge(alarm.id)}
                  >
                    确认
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default AlarmList;
