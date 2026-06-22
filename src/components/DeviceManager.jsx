import React, { useState, useEffect } from 'react';

const api = window.electronAPI;

function DeviceManager({ onDevicesChange }) {
  const [devices, setDevices] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editingDevice, setEditingDevice] = useState(null);
  const [formData, setFormData] = useState({
    device_address: 1,
    name: '',
    location: '',
    probe_type: '电阻探针',
    initial_resistance: 0,
    k_factor: 1.0,
    alarm_threshold: 0.5
  });

  const loadDevices = async () => {
    if (!api) return;
    const result = await api.device.list();
    if (result.success) {
      setDevices(result.data);
      if (onDevicesChange) onDevicesChange();
    }
  };

  useEffect(() => {
    loadDevices();
  }, []);

  const handleAdd = () => {
    setEditingDevice(null);
    setFormData({
      device_address: devices.length > 0 ? Math.max(...devices.map(d => d.device_address)) + 1 : 1,
      name: '',
      location: '',
      probe_type: '电阻探针',
      initial_resistance: 0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });
    setShowModal(true);
  };

  const handleEdit = (device) => {
    setEditingDevice(device);
    setFormData({
      device_address: device.device_address,
      name: device.name,
      location: device.location || '',
      probe_type: device.probe_type || '电阻探针',
      initial_resistance: device.initial_resistance || 0,
      k_factor: device.k_factor || 1.0,
      alarm_threshold: device.alarm_threshold || 0.5
    });
    setShowModal(true);
  };

  const handleDelete = async (device) => {
    if (!api) return;
    if (confirm(`确定要删除设备 "${device.name}" 吗？相关的历史数据也会保留。`)) {
      const result = await api.device.delete(device.device_address);
      if (result.success) {
        loadDevices();
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!api) return;

    if (!formData.name.trim()) {
      alert('请输入设备名称');
      return;
    }

    if (editingDevice) {
      const result = await api.device.update(editingDevice.device_address, formData);
      if (!result.success) {
        alert(`更新失败: ${result.error}`);
        return;
      }
    } else {
      const result = await api.device.create(formData);
      if (!result.success) {
        alert(`创建失败: ${result.error}`);
        return;
      }
    }

    setShowModal(false);
    loadDevices();
  };

  const probeTypes = ['电阻探针', '电感探针', '电化学噪声探针', '线性极化探针'];

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">设备管理</h3>
          <button className="btn btn-primary" onClick={handleAdd}>
            + 添加设备
          </button>
        </div>

        {devices.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🔧</div>
            <div className="empty-state-text">暂无设备，点击上方按钮添加</div>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>设备地址</th>
                <th>设备名称</th>
                <th>安装位置</th>
                <th>探针类型</th>
                <th>初始电阻</th>
                <th>K系数</th>
                <th>报警阈值</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {devices.map(device => (
                <tr key={device.device_address}>
                  <td>{device.device_address}</td>
                  <td><strong>{device.name}</strong></td>
                  <td>{device.location || '-'}</td>
                  <td>{device.probe_type || '-'}</td>
                  <td>{device.initial_resistance} mΩ</td>
                  <td>{device.k_factor}</td>
                  <td>{device.alarm_threshold} mm/y</td>
                  <td>
                    <button
                      className="btn btn-sm btn-default"
                      style={{ marginRight: 4 }}
                      onClick={() => handleEdit(device)}
                    >
                      编辑
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => handleDelete(device)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                {editingDevice ? '编辑设备' : '添加设备'}
              </h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>×</button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">设备地址</label>
                  <input
                    type="number"
                    className="form-input"
                    value={formData.device_address}
                    onChange={(e) => setFormData(prev => ({ ...prev, device_address: Number(e.target.value) }))}
                    min="1"
                    max="255"
                    disabled={!!editingDevice}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">设备名称</label>
                  <input
                    type="text"
                    className="form-input"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="请输入设备名称"
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">安装位置</label>
                  <input
                    type="text"
                    className="form-input"
                    value={formData.location}
                    onChange={(e) => setFormData(prev => ({ ...prev, location: e.target.value }))}
                    placeholder="如：常减压塔进料管线"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">探针类型</label>
                  <select
                    className="form-select"
                    value={formData.probe_type}
                    onChange={(e) => setFormData(prev => ({ ...prev, probe_type: e.target.value }))}
                  >
                    {probeTypes.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">初始电阻 (mΩ)</label>
                  <input
                    type="number"
                    className="form-input"
                    value={formData.initial_resistance}
                    onChange={(e) => setFormData(prev => ({ ...prev, initial_resistance: Number(e.target.value) }))}
                    step="0.0001"
                    min="0"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">K系数</label>
                  <input
                    type="number"
                    className="form-input"
                    value={formData.k_factor}
                    onChange={(e) => setFormData(prev => ({ ...prev, k_factor: Number(e.target.value) }))}
                    step="0.01"
                    min="0.1"
                    max="10"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">报警阈值 (mm/y)</label>
                  <input
                    type="number"
                    className="form-input"
                    value={formData.alarm_threshold}
                    onChange={(e) => setFormData(prev => ({ ...prev, alarm_threshold: Number(e.target.value) }))}
                    step="0.01"
                    min="0.01"
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-default"
                  onClick={() => setShowModal(false)}
                >
                  取消
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingDevice ? '保存修改' : '添加设备'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default DeviceManager;
