const { alarmEventRepo, deviceRepo, corrosionRateRepo } = require('../database');

const ALARM_TYPES = {
  HIGH_CORROSION_RATE: 'high_corrosion_rate',
  CRC_ERROR: 'crc_error',
  DEVICE_DISCONNECTED: 'device_disconnected',
  TIMESTAMP_REVERSE: 'timestamp_reverse',
  TEMPERATURE_ABNORMAL: 'temperature_abnormal',
  RESISTANCE_ABNORMAL: 'resistance_abnormal',
  PROBE_FAULT: 'probe_fault',
  LOW_BATTERY: 'low_battery'
};

const ALARM_LEVELS = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info'
};

class AlarmService {
  constructor() {
    this.alarmCooldown = {};
    this.defaultCooldownMs = 5 * 60 * 1000;
  }

  checkCorrosionRate(deviceAddress, rate) {
    const device = deviceRepo.findByAddress(deviceAddress);
    if (!device) return null;

    const threshold = device.alarm_threshold || 0.5;

    if (rate >= threshold * 2) {
      return this._createAlarm({
        device_address: deviceAddress,
        alarm_type: ALARM_TYPES.HIGH_CORROSION_RATE,
        level: ALARM_LEVELS.CRITICAL,
        message: `腐蚀速率严重超标: ${rate.toFixed(4)} mm/y，阈值: ${threshold} mm/y`,
        corrosion_rate_id: null
      });
    } else if (rate >= threshold) {
      return this._createAlarm({
        device_address: deviceAddress,
        alarm_type: ALARM_TYPES.HIGH_CORROSION_RATE,
        level: ALARM_LEVELS.WARNING,
        message: `腐蚀速率超标: ${rate.toFixed(4)} mm/y，阈值: ${threshold} mm/y`,
        corrosion_rate_id: null
      });
    }

    return null;
  }

  checkReading(reading) {
    const alarms = [];

    if (!reading.crc_valid) {
      alarms.push(this._createAlarm({
        device_address: reading.device_address,
        alarm_type: ALARM_TYPES.CRC_ERROR,
        level: ALARM_LEVELS.WARNING,
        message: 'CRC校验失败，数据可能损坏',
        reading_id: reading.id
      }));
    }

    if (reading.temperature < -40 || reading.temperature > 150) {
      alarms.push(this._createAlarm({
        device_address: reading.device_address,
        alarm_type: ALARM_TYPES.TEMPERATURE_ABNORMAL,
        level: ALARM_LEVELS.WARNING,
        message: `温度异常: ${reading.temperature}°C`,
        reading_id: reading.id
      }));
    }

    if (reading.resistance <= 0 || reading.resistance > 10000) {
      alarms.push(this._createAlarm({
        device_address: reading.device_address,
        alarm_type: ALARM_TYPES.RESISTANCE_ABNORMAL,
        level: ALARM_LEVELS.WARNING,
        message: `电阻值异常: ${reading.resistance} mΩ`,
        reading_id: reading.id
      }));
    }

    if (reading.status) {
      if (!reading.status.probe_ok) {
        alarms.push(this._createAlarm({
          device_address: reading.device_address,
          alarm_type: ALARM_TYPES.PROBE_FAULT,
          level: ALARM_LEVELS.CRITICAL,
          message: '探针故障',
          reading_id: reading.id
        }));
      }

      if (reading.status.low_battery) {
        alarms.push(this._createAlarm({
          device_address: reading.device_address,
          alarm_type: ALARM_TYPES.LOW_BATTERY,
          level: ALARM_LEVELS.INFO,
          message: '电池电量低',
          reading_id: reading.id
        }));
      }
    }

    return alarms.filter(a => a !== null);
  }

  checkTimestamp(current, previous) {
    if (previous && current.timestamp < previous.timestamp) {
      return this._createAlarm({
        device_address: current.device_address,
        alarm_type: ALARM_TYPES.TIMESTAMP_REVERSE,
        level: ALARM_LEVELS.WARNING,
        message: '时间戳倒退，可能存在时钟同步问题',
        reading_id: current.id
      });
    }
    return null;
  }

  deviceDisconnected(deviceAddress) {
    return this._createAlarm({
      device_address: deviceAddress,
      alarm_type: ALARM_TYPES.DEVICE_DISCONNECTED,
      level: ALARM_LEVELS.CRITICAL,
      message: '设备连接断开',
      reading_id: null
    }, 0);
  }

  _createAlarm(alarmData, cooldownMs) {
    const cooldown = cooldownMs !== undefined ? cooldownMs : this.defaultCooldownMs;
    const key = `${alarmData.device_address}_${alarmData.alarm_type}`;
    const now = Date.now();

    if (cooldown > 0) {
      const lastAlarm = this.alarmCooldown[key];
      if (lastAlarm && now - lastAlarm < cooldown) {
        return null;
      }
      this.alarmCooldown[key] = now;
    }

    const id = alarmEventRepo.create(alarmData);
    return {
      id,
      ...alarmData,
      created_at: now
    };
  }

  getAlarms(limit = 100, offset = 0) {
    return alarmEventRepo.findAll(limit, offset);
  }

  getUnacknowledged() {
    return alarmEventRepo.findUnacknowledged();
  }

  acknowledgeAlarm(id) {
    return alarmEventRepo.acknowledge(id);
  }

  clearCooldown() {
    this.alarmCooldown = {};
  }
}

const alarmService = new AlarmService();

module.exports = {
  AlarmService,
  alarmService,
  ALARM_TYPES,
  ALARM_LEVELS
};
