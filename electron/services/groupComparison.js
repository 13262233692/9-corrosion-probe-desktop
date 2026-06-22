const { EventEmitter } = require('events');
const {
  probeReadingRepo,
  alarmEventRepo,
  deviceRepo,
  probeGroupRepo,
  groupAlarmRuleRepo
} = require('../database');
const {
  calculateSlidingWindowRate,
  calculateCorrosionTrend,
  temperatureCompensation,
  DEFAULT_TEMP_COEFFICIENT,
  DEFAULT_REFERENCE_TEMP
} = require('./corrosionRate');

const RULE_TYPE_SPIKE = 'rate_spike';
const RULE_TYPE_DEVIATION = 'group_deviation';
const RULE_TYPE_MISSING_SAMPLES = 'missing_samples';
const RULE_TYPE_ABNORMAL_TEMP = 'abnormal_temperature';

const VALID_RULE_TYPES = [
  RULE_TYPE_SPIKE,
  RULE_TYPE_DEVIATION,
  RULE_TYPE_MISSING_SAMPLES,
  RULE_TYPE_ABNORMAL_TEMP
];

const DEFAULT_SPIKE_RATIO = 2.0;
const DEFAULT_DEVIATION_RATIO = 0.5;
const DEFAULT_MISSING_THRESHOLD = 3;
const DEFAULT_TEMP_RANGE = { min: -20, max: 120 };

const GROUP_ALARM_COOLDOWN_MS = 30 * 60 * 1000;

class GroupComparisonService extends EventEmitter {
  constructor() {
    super();
    this._cooldownCache = new Map();
    this._tempRange = { ...DEFAULT_TEMP_RANGE };
  }

  setTempRange(min, max) {
    this._tempRange = { min, max };
  }

  _getCooldownKey(groupId, ruleType, deviceAddress) {
    return `${groupId}:${ruleType}:${deviceAddress || 'group'}`;
  }

  _isCooldownActive(key) {
    const lastFired = this._cooldownCache.get(key);
    if (!lastFired) return false;
    return (Date.now() - lastFired) < GROUP_ALARM_COOLDOWN_MS;
  }

  _setCooldown(key) {
    this._cooldownCache.set(key, Date.now());
  }

  _fireAlarm(alarmData) {
    const key = this._getCooldownKey(
      alarmData.group_id,
      alarmData.rule_type,
      alarmData.device_address
    );

    if (this._isCooldownActive(key)) {
      return { ...alarmData, deduped: true, alarm_id: null };
    }

    const id = alarmEventRepo.create({
      device_address: alarmData.device_address || 0,
      alarm_type: `group_${alarmData.rule_type}`,
      level: alarmData.level || 'warning',
      message: alarmData.message,
      reading_id: alarmData.reading_id || null,
      corrosion_rate_id: alarmData.corrosion_rate_id || null
    });

    this._setCooldown(key);
    this.emit('group-alarm', { ...alarmData, alarm_id: id });

    return { ...alarmData, deduped: false, alarm_id: id };
  }

  getMultiDeviceRates(deviceAddresses, options = {}) {
    const windowHours = options.windowHours || 24;
    const results = [];

    for (const addr of deviceAddresses) {
      try {
        const rate = calculateSlidingWindowRate(addr, { windowHours });
        const device = deviceRepo.findByAddress(addr);
        results.push({
          device_address: addr,
          device_name: device ? device.name : `设备#${addr}`,
          ...rate,
          error: null
        });
      } catch (e) {
        results.push({
          device_address: addr,
          device_name: `设备#${addr}`,
          rate: 0,
          unit: 'mm/y',
          sample_count: 0,
          error: e.message
        });
      }
    }

    return results;
  }

  getMultiDeviceTrends(deviceAddresses, startTime, endTime, options = {}) {
    const intervalHours = options.intervalHours || 1;
    const series = [];

    for (const addr of deviceAddresses) {
      const device = deviceRepo.findByAddress(addr);
      try {
        const points = calculateCorrosionTrend(addr, startTime, endTime, intervalHours);
        series.push({
          device_address: addr,
          device_name: device ? device.name : `设备#${addr}`,
          points
        });
      } catch (e) {
        series.push({
          device_address: addr,
          device_name: device ? device.name : `设备#${addr}`,
          points: [],
          error: e.message
        });
      }
    }

    return series;
  }

  _detectRateSpike(deviceAddress, rule, groupName) {
    const shortWindow = Math.max(1, Math.floor(rule.window_hours / 6));
    const longWindow = rule.window_hours;

    let shortRate, longRate;
    try {
      shortRate = calculateSlidingWindowRate(deviceAddress, { windowHours: shortWindow });
      longRate = calculateSlidingWindowRate(deviceAddress, { windowHours: longWindow });
    } catch (e) {
      return null;
    }

    if (shortRate.error || longRate.error) {
      return null;
    }

    if (longRate.rate === 0 && shortRate.rate > 0) {
      if (shortRate.sample_count >= 2) {
        const device = deviceRepo.findByAddress(deviceAddress);
        const name = device ? device.name : `设备#${deviceAddress}`;
        return {
          group_id: rule.group_id,
          group_name: groupName,
          rule_type: RULE_TYPE_SPIKE,
          rule_id: rule.id,
          device_address: deviceAddress,
          device_name: name,
          level: rule.level,
          threshold: rule.threshold,
          short_window_hours: shortWindow,
          long_window_hours: longWindow,
          short_rate: shortRate.rate,
          long_rate: longRate.rate,
          ratio: Infinity,
          sample_count_short: shortRate.sample_count,
          sample_count_long: longRate.sample_count,
          message: `[${groupName}] ${name} 速率突增：新窗口(${shortWindow}h)速率=${shortRate.rate.toFixed(4)} mm/y，原窗口(${longWindow}h)速率=0，比率超过阈值 ${rule.threshold}`
        };
      }
      return null;
    }

    if (longRate.rate <= 0) return null;

    const ratio = shortRate.rate / longRate.rate;

    if (ratio >= rule.threshold) {
      const device = deviceRepo.findByAddress(deviceAddress);
      const name = device ? device.name : `设备#${deviceAddress}`;
      return {
        group_id: rule.group_id,
        group_name: groupName,
        rule_type: RULE_TYPE_SPIKE,
        rule_id: rule.id,
        device_address: deviceAddress,
        device_name: name,
        level: rule.level,
        threshold: rule.threshold,
        short_window_hours: shortWindow,
        long_window_hours: longWindow,
        short_rate: shortRate.rate,
        long_rate: longRate.rate,
        ratio: Math.round(ratio * 10000) / 10000,
        sample_count_short: shortRate.sample_count,
        sample_count_long: longRate.sample_count,
        message: `[${groupName}] ${name} 速率突增：${shortWindow}h窗口速率=${shortRate.rate.toFixed(4)} mm/y，${longWindow}h窗口速率=${longRate.rate.toFixed(4)} mm/y，比率=${(ratio).toFixed(2)}x，阈值=${rule.threshold}x`
      };
    }

    return null;
  }

  _detectGroupDeviation(deviceAddresses, rule, groupName) {
    const rates = [];
    const windowHours = rule.window_hours;
    const MIN_VALID_SAMPLES = 5;

    for (const addr of deviceAddresses) {
      try {
        const r = calculateSlidingWindowRate(addr, { windowHours });
        if (!r.error) {
          rates.push({
            device_address: addr,
            rate: r.rate,
            sample_count: r.sample_count
          });
        }
      } catch (e) {}
    }

    if (rates.length < 2) {
      return {
        skipped: true,
        group_id: rule.group_id,
        rule_type: RULE_TYPE_DEVIATION,
        reason: '有效样本设备不足',
        available_devices: rates.length
      };
    }

    const validRates = rates.filter(r => r.sample_count >= MIN_VALID_SAMPLES);
    if (validRates.length < 2) {
      return {
        skipped: true,
        group_id: rule.group_id,
        rule_type: RULE_TYPE_DEVIATION,
        reason: '采样窗口不足',
        available_devices: validRates.length,
        min_required_samples: MIN_VALID_SAMPLES
      };
    }

    const rateValues = validRates.map(r => r.rate);
    const mean = rateValues.reduce((a, b) => a + b, 0) / rateValues.length;

    if (mean === 0) {
      if (Math.max(...rateValues) > 0) {
        const maxIdx = rateValues.indexOf(Math.max(...rateValues));
        const outlier = validRates[maxIdx];
        const device = deviceRepo.findByAddress(outlier.device_address);
        const name = device ? device.name : `设备#${outlier.device_address}`;
        return {
          group_id: rule.group_id,
          group_name: groupName,
          rule_type: RULE_TYPE_DEVIATION,
          rule_id: rule.id,
          level: rule.level,
          threshold: rule.threshold,
          window_hours: windowHours,
          mean_rate: 0,
          outliers: [outlier.device_address],
          outlier_details: [{
            device_address: outlier.device_address,
            device_name: name,
            rate: outlier.rate,
            deviation_ratio: Infinity
          }],
          message: `[${groupName}] 组偏差异常：均值=0 mm/y，但 ${name} 速率=${outlier.rate.toFixed(4)} mm/y，存在异常离群点`
        };
      }
      return null;
    }

    const outliers = [];
    for (const r of validRates) {
      const deviationRatio = Math.abs(r.rate - mean) / mean;
      if (deviationRatio >= rule.threshold) {
        const device = deviceRepo.findByAddress(r.device_address);
        outliers.push({
          device_address: r.device_address,
          device_name: device ? device.name : `设备#${r.device_address}`,
          rate: r.rate,
          deviation_ratio: Math.round(deviationRatio * 10000) / 10000
        });
      }
    }

    if (outliers.length > 0) {
      return {
        group_id: rule.group_id,
        group_name: groupName,
        rule_type: RULE_TYPE_DEVIATION,
        rule_id: rule.id,
        level: rule.level,
        threshold: rule.threshold,
        window_hours: windowHours,
        mean_rate: Math.round(mean * 100000) / 100000,
        min_rate: Math.round(Math.min(...rateValues) * 100000) / 100000,
        max_rate: Math.round(Math.max(...rateValues) * 100000) / 100000,
        outliers: outliers.map(o => o.device_address),
        outlier_details: outliers,
        message: `[${groupName}] 组内${outliers.length}个测点偏差超过阈值(${rule.threshold * 100}%)：均值=${mean.toFixed(4)} mm/y，异常测点：${outliers.map(o => `${o.device_name}(${o.rate.toFixed(4)}, ${(o.deviation_ratio * 100).toFixed(0)}%偏离)`).join('；')}`
      };
    }

    return null;
  }

  _detectMissingSamples(deviceAddresses, rule, groupName) {
    const threshold = rule.threshold || DEFAULT_MISSING_THRESHOLD;
    const windowMs = rule.window_hours * 60 * 60 * 1000;
    const endTime = Date.now();
    const startTime = endTime - windowMs;
    const issues = [];

    for (const addr of deviceAddresses) {
      const readings = probeReadingRepo.findByTimeRange(addr, startTime, endTime);
      const validCount = readings.filter(r => r.crc_valid).length;

      if (validCount < threshold) {
        const device = deviceRepo.findByAddress(addr);
        const name = device ? device.name : `设备#${addr}`;
        issues.push({
          device_address: addr,
          device_name: name,
          sample_count: validCount,
          expected_min: threshold
        });
      }
    }

    if (issues.length > 0) {
      return {
        group_id: rule.group_id,
        group_name: groupName,
        rule_type: RULE_TYPE_MISSING_SAMPLES,
        rule_id: rule.id,
        level: 'info',
        threshold,
        window_hours: rule.window_hours,
        devices_with_issue: issues.map(i => i.device_address),
        details: issues,
        message: `[${groupName}] ${issues.length}个设备采样不足：${issues.map(i => `${i.device_name}(${i.sample_count}/${threshold})`).join('，')}`
      };
    }

    return null;
  }

  _detectAbnormalTemperature(deviceAddresses, rule, groupName) {
    const minTemp = this._tempRange.min;
    const maxTemp = this._tempRange.max;
    const windowMs = rule.window_hours * 60 * 60 * 1000;
    const endTime = Date.now();
    const startTime = endTime - windowMs;
    const issues = [];

    for (const addr of deviceAddresses) {
      const readings = probeReadingRepo.findByTimeRange(addr, startTime, endTime)
        .filter(r => r.crc_valid);

      const abnormal = readings.filter(r => r.temperature < minTemp || r.temperature > maxTemp);

      if (abnormal.length > 0) {
        const device = deviceRepo.findByAddress(addr);
        const name = device ? device.name : `设备#${addr}`;
        const minFound = Math.min(...readings.map(r => r.temperature));
        const maxFound = Math.max(...readings.map(r => r.temperature));
        issues.push({
          device_address: addr,
          device_name: name,
          abnormal_count: abnormal.length,
          total_count: readings.length,
          min_temp: minFound,
          max_temp: maxFound,
          range_min: minTemp,
          range_max: maxTemp
        });
      }
    }

    if (issues.length > 0) {
      return {
        group_id: rule.group_id,
        group_name: groupName,
        rule_type: RULE_TYPE_ABNORMAL_TEMP,
        rule_id: rule.id,
        level: rule.level || 'warning',
        threshold: rule.threshold,
        window_hours: rule.window_hours,
        devices_with_issue: issues.map(i => i.device_address),
        details: issues,
        message: `[${groupName}] ${issues.length}个设备温度异常(${minTemp}°C~${maxTemp}°C)：${issues.map(i => `${i.device_name}(实测${i.min_temp.toFixed(1)}~${i.max_temp.toFixed(1)}°C，共${i.abnormal_count}条)`).join('，')}`
      };
    }

    return null;
  }

  evaluateGroup(groupId) {
    const group = probeGroupRepo.findById(groupId);
    if (!group) {
      throw new Error(`探针组不存在: ${groupId}`);
    }

    if (!group.enabled) {
      return { group_id: groupId, skipped: true, reason: '探针组已禁用' };
    }

    const rules = groupAlarmRuleRepo.findEnabledByGroupId(groupId);
    const results = [];
    const alarms = [];

    for (const rule of rules) {
      let result;

      switch (rule.rule_type) {
        case RULE_TYPE_SPIKE:
          for (const addr of group.device_addresses) {
            const spike = this._detectRateSpike(addr, rule, group.name);
            if (spike) {
              const fired = this._fireAlarm(spike);
              results.push(fired);
              if (!fired.deduped) alarms.push(fired);
            }
          }
          break;

        case RULE_TYPE_DEVIATION:
          result = this._detectGroupDeviation(group.device_addresses, rule, group.name);
          if (result && !result.skipped) {
            const fired = this._fireAlarm({
              ...result,
              device_address: result.outliers && result.outliers[0] ? result.outliers[0] : 0
            });
            results.push(fired);
            if (!fired.deduped) alarms.push(fired);
          } else if (result && result.skipped) {
            results.push(result);
          }
          break;

        case RULE_TYPE_MISSING_SAMPLES:
          result = this._detectMissingSamples(group.device_addresses, rule, group.name);
          if (result) {
            const baseResult = { ...result };
            if (result.details && result.details.length > 0) {
              for (const detail of result.details) {
                const fired = this._fireAlarm({
                  ...baseResult,
                  device_address: detail.device_address,
                  devices_with_issue: [detail.device_address],
                  details: [detail],
                  message: `[${group.name}] ${detail.device_name} 采样不足：${detail.sample_count}/${result.threshold}`,
                  level: 'info'
                });
                results.push(fired);
                if (!fired.deduped) alarms.push(fired);
              }
            } else {
              const fired = this._fireAlarm({
                ...baseResult,
                device_address: 0,
                level: 'info'
              });
              results.push(fired);
              if (!fired.deduped) alarms.push(fired);
            }
          }
          break;

        case RULE_TYPE_ABNORMAL_TEMP:
          result = this._detectAbnormalTemperature(group.device_addresses, rule, group.name);
          if (result) {
            const baseResult = { ...result };
            if (result.details && result.details.length > 0) {
              for (const detail of result.details) {
                const fired = this._fireAlarm({
                  ...baseResult,
                  device_address: detail.device_address,
                  devices_with_issue: [detail.device_address],
                  details: [detail],
                  message: `[${group.name}] ${detail.device_name} 温度异常(${detail.min_temp}~${detail.max_temp}°C)`,
                  level: baseResult.level
                });
                results.push(fired);
                if (!fired.deduped) alarms.push(fired);
              }
            } else {
              const fired = this._fireAlarm({
                ...baseResult,
                device_address: 0
              });
              results.push(fired);
              if (!fired.deduped) alarms.push(fired);
            }
          }
          break;

        default:
          results.push({
            skipped: true,
            group_id: groupId,
            rule_id: rule.id,
            rule_type: rule.rule_type,
            reason: `未知的规则类型: ${rule.rule_type}`
          });
      }
    }

    return {
      group_id: groupId,
      group_name: group.name,
      device_count: group.device_addresses.length,
      rule_count: rules.length,
      results,
      alarms,
      alarm_count: alarms.length
    };
  }

  evaluateAllGroups() {
    const groups = probeGroupRepo.findEnabled();
    const summary = [];

    for (const group of groups) {
      try {
        const result = this.evaluateGroup(group.id);
        summary.push(result);
      } catch (e) {
        summary.push({
          group_id: group.id,
          group_name: group.name,
          error: e.message
        });
      }
    }

    return {
      evaluated_at: Date.now(),
      group_count: groups.length,
      results: summary
    };
  }

  generateComparisonReport(deviceAddresses, options = {}) {
    const windowHours = options.windowHours || 24;
    const rateResults = this.getMultiDeviceRates(deviceAddresses, { windowHours });

    const validRates = rateResults.filter(r => !r.error && r.sample_count >= 2);
    const invalidRates = rateResults.filter(r => r.error || r.sample_count < 2);

    let summary = {
      window_hours: windowHours,
      total_devices: deviceAddresses.length,
      valid_devices: validRates.length,
      invalid_devices: invalidRates.length
    };

    if (validRates.length >= 1) {
      const rateValues = validRates.map(r => r.rate);
      summary.mean_rate = rateValues.reduce((a, b) => a + b, 0) / rateValues.length;
      summary.min_rate = Math.min(...rateValues);
      summary.max_rate = Math.max(...rateValues);
      summary.rate_range = summary.max_rate - summary.min_rate;

      const maxIdx = rateValues.indexOf(summary.max_rate);
      const minIdx = rateValues.indexOf(summary.min_rate);
      summary.fastest_device = validRates[maxIdx];
      summary.slowest_device = validRates[minIdx];

      if (summary.mean_rate > 0) {
        summary.max_deviation_ratio = summary.rate_range / summary.mean_rate;
      }

      const threshold = options.alarmThreshold || 0.5;
      const overThreshold = validRates.filter(r => r.rate >= threshold);
      summary.over_threshold_count = overThreshold.length;
      summary.over_threshold_devices = overThreshold.map(r => ({
        device_address: r.device_address,
        device_name: r.device_name,
        rate: r.rate
      }));
    }

    let conclusion;
    if (validRates.length === 0) {
      conclusion = '所有设备采样不足，无法生成有效对比结论。建议检查设备连接状态。';
    } else if (validRates.length < deviceAddresses.length) {
      conclusion = `部分设备采样不足(${invalidRates.length}/${deviceAddresses.length})。`;
      if (summary.over_threshold_count > 0) {
        conclusion += ` 其中 ${summary.over_threshold_count} 台设备腐蚀速率超过阈值 ${options.alarmThreshold || 0.5} mm/y。`;
      }
      if (summary.max_deviation_ratio && summary.max_deviation_ratio > 0.5) {
        conclusion += ` 组内最大偏差率达 ${(summary.max_deviation_ratio * 100).toFixed(0)}%，建议关注最高速测点：${summary.fastest_device.device_name}。`;
      }
    } else {
      conclusion = `${validRates.length} 台设备数据采集正常。`;
      if (summary.over_threshold_count > 0) {
        conclusion += ` ${summary.over_threshold_count} 台超过阈值：${summary.over_threshold_devices.map(d => d.device_name).join('、')}。`;
      }
      if (summary.max_deviation_ratio && summary.max_deviation_ratio > 0.5) {
        conclusion += ` 测点间速率差异较大(偏差${(summary.max_deviation_ratio * 100).toFixed(0)}%)，最快:${summary.fastest_device.device_name}(${summary.max_rate.toFixed(4)})，最慢:${summary.slowest_device.device_name}(${summary.min_rate.toFixed(4)})。`;
      } else {
        conclusion += ` 测点间腐蚀速率较为均衡(最大偏差率${summary.max_deviation_ratio ? (summary.max_deviation_ratio * 100).toFixed(0) : 0}%)。`;
      }
    }

    return {
      summary,
      details: rateResults,
      conclusion,
      conclusions: [
        conclusion,
        invalidRates.length > 0
          ? `数据完整性: ${((validRates.length / deviceAddresses.length) * 100).toFixed(0)}% (${validRates.length}/${deviceAddresses.length}台有效)`
          : `数据完整性: 100% (全部${deviceAddresses.length}台设备采样正常)`
      ]
    };
  }

  clearCooldown() {
    this._cooldownCache.clear();
  }

  getCooldownStatus() {
    return {
      active_count: this._cooldownCache.size,
      keys: Array.from(this._cooldownCache.entries()).map(([k, v]) => ({
        key: k,
        fired_at: v,
        remaining_ms: Math.max(0, GROUP_ALARM_COOLDOWN_MS - (Date.now() - v))
      }))
    };
  }
}

const groupComparisonService = new GroupComparisonService();

module.exports = {
  GroupComparisonService,
  groupComparisonService,
  RULE_TYPE_SPIKE,
  RULE_TYPE_DEVIATION,
  RULE_TYPE_MISSING_SAMPLES,
  RULE_TYPE_ABNORMAL_TEMP,
  VALID_RULE_TYPES,
  DEFAULT_SPIKE_RATIO,
  DEFAULT_DEVIATION_RATIO,
  DEFAULT_MISSING_THRESHOLD,
  GROUP_ALARM_COOLDOWN_MS
};
