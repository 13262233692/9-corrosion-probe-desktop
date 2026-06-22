const { temperatureCompensation } = require('../protocol');
const { probeReadingRepo, corrosionRateRepo, deviceRepo } = require('../database');

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_K_FACTOR = 1.0;
const DEFAULT_REFERENCE_TEMP = 25;
const DEFAULT_TEMP_COEFFICIENT = 0.00393;

function calculateCorrosionRate(resistanceChange, initialResistance, kFactor, timeHours) {
  if (initialResistance <= 0 || timeHours <= 0) {
    return 0;
  }

  const normalizedChange = resistanceChange / initialResistance;
  const ratePerHour = normalizedChange / timeHours;
  const ratePerYear = ratePerHour * 24 * 365 * kFactor;

  return Math.round(ratePerYear * 100000) / 100000;
}

function calculateSlidingWindowRate(deviceAddress, options = {}) {
  const windowHours = options.windowHours || DEFAULT_WINDOW_HOURS;
  const kFactor = options.kFactor || DEFAULT_K_FACTOR;
  const referenceTemp = options.referenceTemp || DEFAULT_REFERENCE_TEMP;
  const tempCoefficient = options.tempCoefficient || DEFAULT_TEMP_COEFFICIENT;

  const device = deviceRepo.findByAddress(deviceAddress);
  if (!device) {
    throw new Error(`设备不存在: ${deviceAddress}`);
  }

  const endTime = Date.now();
  const startTime = endTime - windowHours * 60 * 60 * 1000;

  const readings = probeReadingRepo.findByTimeRange(deviceAddress, startTime, endTime);

  if (readings.length < 2) {
    return {
      rate: 0,
      unit: 'mm/y',
      window_start: startTime,
      window_end: endTime,
      sample_count: readings.length,
      error: '样本数量不足'
    };
  }

  const compensatedReadings = readings
    .filter(r => r.crc_valid)
    .map(r => ({
      ...r,
      compensated_resistance: temperatureCompensation(
        r.resistance,
        r.temperature,
        referenceTemp,
        tempCoefficient
      )
    }));

  if (compensatedReadings.length < 2) {
    return {
      rate: 0,
      unit: 'mm/y',
      window_start: startTime,
      window_end: endTime,
      sample_count: compensatedReadings.length,
      error: '有效样本数量不足'
    };
  }

  const firstReading = compensatedReadings[0];
  const lastReading = compensatedReadings[compensatedReadings.length - 1];

  const initialResistance = device.initial_resistance > 0
    ? device.initial_resistance
    : firstReading.compensated_resistance;

  const resistanceChange = lastReading.compensated_resistance - firstReading.compensated_resistance;

  const timeHours = (lastReading.timestamp - firstReading.timestamp) / (1000 * 60 * 60);

  const actualKFactor = device.k_factor || kFactor;
  const rate = calculateCorrosionRate(
    resistanceChange,
    initialResistance,
    actualKFactor,
    timeHours
  );

  return {
    device_address: deviceAddress,
    rate: Math.abs(rate),
    unit: 'mm/y',
    window_start: firstReading.timestamp,
    window_end: lastReading.timestamp,
    sample_count: compensatedReadings.length,
    initial_resistance: initialResistance,
    first_resistance: firstReading.compensated_resistance,
    last_resistance: lastReading.compensated_resistance,
    resistance_change: resistanceChange
  };
}

function calculateMultipleWindows(deviceAddress, windowSizes = [1, 6, 24, 168, 720]) {
  const device = deviceRepo.findByAddress(deviceAddress);
  if (!device) {
    throw new Error(`设备不存在: ${deviceAddress}`);
  }

  const results = [];
  for (const hours of windowSizes) {
    const result = calculateSlidingWindowRate(deviceAddress, {
      windowHours: hours,
      kFactor: device.k_factor
    });
    results.push({
      window_hours: hours,
      window_label: formatWindowLabel(hours),
      ...result
    });
  }

  return results;
}

function formatWindowLabel(hours) {
  if (hours < 24) return `${hours}小时`;
  if (hours === 24) return '1天';
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days}天`;
  }
  return `${hours}小时`;
}

function storeCorrosionRate(deviceAddress, windowHours = DEFAULT_WINDOW_HOURS) {
  const result = calculateSlidingWindowRate(deviceAddress, { windowHours });

  if (result.error) {
    return null;
  }

  const id = corrosionRateRepo.create(result);

  return {
    id,
    ...result
  };
}

function calculateCorrosionTrend(deviceAddress, startTime, endTime, intervalHours = 1) {
  const device = deviceRepo.findByAddress(deviceAddress);
  if (!device) {
    throw new Error(`设备不存在: ${deviceAddress}`);
  }

  const readings = probeReadingRepo.findByTimeRange(deviceAddress, startTime, endTime);

  if (readings.length < 2) {
    return [];
  }

  const points = [];
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const windowMs = 24 * 60 * 60 * 1000;

  let currentTime = startTime;
  while (currentTime <= endTime) {
    const windowStart = currentTime - windowMs;
    const windowReadings = readings.filter(
      r => r.timestamp >= windowStart && r.timestamp <= currentTime && r.crc_valid
    );

    if (windowReadings.length >= 2) {
      const first = windowReadings[0];
      const last = windowReadings[windowReadings.length - 1];

      const firstComp = temperatureCompensation(first.resistance, first.temperature);
      const lastComp = temperatureCompensation(last.resistance, last.temperature);

      const initialRes = device.initial_resistance > 0
        ? device.initial_resistance
        : firstComp;

      const timeHours = (last.timestamp - first.timestamp) / (1000 * 60 * 60);
      const rate = calculateCorrosionRate(
        lastComp - firstComp,
        initialRes,
        device.k_factor || 1.0,
        timeHours
      );

      points.push({
        timestamp: currentTime,
        rate: Math.abs(rate),
        sample_count: windowReadings.length
      });
    }

    currentTime += intervalMs;
  }

  return points;
}

module.exports = {
  calculateCorrosionRate,
  calculateSlidingWindowRate,
  calculateMultipleWindows,
  storeCorrosionRate,
  calculateCorrosionTrend,
  temperatureCompensation,
  DEFAULT_WINDOW_HOURS,
  DEFAULT_K_FACTOR,
  DEFAULT_REFERENCE_TEMP,
  DEFAULT_TEMP_COEFFICIENT
};
