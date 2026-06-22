const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  calculateCorrosionRate,
  calculateSlidingWindowRate
} = require('../electron/services/corrosionRate');

const {
  initDatabase,
  closeDatabase,
  deviceRepo,
  probeReadingRepo,
  getDatabase
} = require('../electron/database');

const { AlarmService, ALARM_TYPES, ALARM_LEVELS } = require('../electron/services/alarm');
const { generateCsvReport } = require('../electron/services/report');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

let tmpDir;
let dbPath;

function setupTestDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrosion-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  initDatabase(dbPath);
}

function cleanupTestDb() {
  closeDatabase();
}

console.log('\n=== 腐蚀速率计算 ===');

test('零时间应该返回 0', () => {
  const rate = calculateCorrosionRate(1, 100, 1.0, 0);
  assert.strictEqual(rate, 0);
});

test('零初始电阻应该返回 0', () => {
  const rate = calculateCorrosionRate(1, 0, 1.0, 1);
  assert.strictEqual(rate, 0);
});

test('电阻变化越大，速率越大', () => {
  const rate1 = calculateCorrosionRate(0.1, 100, 1.0, 1);
  const rate2 = calculateCorrosionRate(0.5, 100, 1.0, 1);
  assert.ok(rate2 > rate1);
});

test('时间越短，速率越大（相同变化量）', () => {
  const rate1 = calculateCorrosionRate(0.1, 100, 1.0, 1);
  const rate2 = calculateCorrosionRate(0.1, 100, 1.0, 0.5);
  assert.ok(rate2 > rate1);
});

test('K 系数应该正比例影响速率', () => {
  const rate1 = calculateCorrosionRate(0.1, 100, 1.0, 1);
  const rate2 = calculateCorrosionRate(0.1, 100, 2.0, 1);
  assert.ok(Math.abs(rate2 - rate1 * 2) < 0.00001);
});

test('腐蚀速率结果应该为正值（输入正变化）', () => {
  const rate = calculateCorrosionRate(0.1, 100, 1.0, 1);
  assert.ok(rate > 0);
});

console.log('\n=== 滑动窗口腐蚀速率计算 ===');

test('样本不足时应该返回错误', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const result = calculateSlidingWindowRate(1, { windowHours: 24 });
    assert.ok(result.error !== undefined);
    assert.strictEqual(result.rate, 0);
    assert.strictEqual(result.sample_count, 0);
  } finally {
    cleanupTestDb();
  }
});

test('有足够样本时应该计算出速率', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;

    probeReadingRepo.create({
      device_address: 1,
      resistance: 100.0,
      temperature: 25.0,
      timestamp: hourAgo,
      crc_valid: true
    });

    probeReadingRepo.create({
      device_address: 1,
      resistance: 100.1,
      temperature: 25.0,
      timestamp: now,
      crc_valid: true
    });

    const result = calculateSlidingWindowRate(1, { windowHours: 24 });

    assert.strictEqual(result.error, undefined);
    assert.ok(result.rate > 0);
    assert.strictEqual(result.sample_count, 2);
  } finally {
    cleanupTestDb();
  }
});

test('CRC 无效的数据不应参与计算', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    probeReadingRepo.create({
      device_address: 1,
      resistance: 100.0,
      temperature: 25.0,
      timestamp: dayAgo,
      crc_valid: false
    });

    probeReadingRepo.create({
      device_address: 1,
      resistance: 100.1,
      temperature: 25.0,
      timestamp: now,
      crc_valid: true
    });

    const result = calculateSlidingWindowRate(1, { windowHours: 24 });
    assert.strictEqual(result.sample_count, 1);
    assert.ok(result.error !== undefined);
  } finally {
    cleanupTestDb();
  }
});

test('设备不存在时应该抛出异常', () => {
  setupTestDb();
  try {
    assert.throws(() => calculateSlidingWindowRate(999), /设备不存在/);
  } finally {
    cleanupTestDb();
  }
});

console.log('\n=== 报警检测服务 ===');

test('腐蚀速率超标应该产生警告报警', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const alarmService = new AlarmService();
    const alarm = alarmService.checkCorrosionRate(1, 0.75);
    assert.ok(alarm !== null);
    assert.strictEqual(alarm.alarm_type, ALARM_TYPES.HIGH_CORROSION_RATE);
    assert.strictEqual(alarm.level, ALARM_LEVELS.WARNING);
  } finally {
    cleanupTestDb();
  }
});

test('腐蚀速率严重超标应该产生严重报警', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const alarmService = new AlarmService();
    const alarm = alarmService.checkCorrosionRate(1, 1.5);
    assert.ok(alarm !== null);
    assert.strictEqual(alarm.level, ALARM_LEVELS.CRITICAL);
  } finally {
    cleanupTestDb();
  }
});

test('腐蚀速率在阈值以下不产生报警', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const alarmService = new AlarmService();
    const alarm = alarmService.checkCorrosionRate(1, 0.1);
    assert.strictEqual(alarm, null);
  } finally {
    cleanupTestDb();
  }
});

test('CRC 错误应该产生报警', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const alarmService = new AlarmService();
    const alarms = alarmService.checkReading({
      device_address: 1,
      resistance: 100.0,
      temperature: 25.0,
      timestamp: Date.now(),
      crc_valid: false,
      status: { probe_ok: true }
    });

    assert.ok(alarms.length > 0);
    assert.ok(alarms.some(a => a.alarm_type === ALARM_TYPES.CRC_ERROR));
  } finally {
    cleanupTestDb();
  }
});

test('温度异常应该产生报警', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const alarmService = new AlarmService();
    const alarms = alarmService.checkReading({
      device_address: 1,
      resistance: 100.0,
      temperature: 200,
      timestamp: Date.now(),
      crc_valid: true,
      status: { probe_ok: true }
    });

    assert.ok(alarms.some(a => a.alarm_type === ALARM_TYPES.TEMPERATURE_ABNORMAL));
  } finally {
    cleanupTestDb();
  }
});

test('探针故障应该产生严重报警', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const alarmService = new AlarmService();
    const alarms = alarmService.checkReading({
      device_address: 1,
      resistance: 100.0,
      temperature: 25.0,
      timestamp: Date.now(),
      crc_valid: true,
      status: { probe_ok: false }
    });

    assert.ok(alarms.some(a => a.alarm_type === ALARM_TYPES.PROBE_FAULT));
    assert.strictEqual(
      alarms.find(a => a.alarm_type === ALARM_TYPES.PROBE_FAULT).level,
      ALARM_LEVELS.CRITICAL
    );
  } finally {
    cleanupTestDb();
  }
});

test('设备断开应该产生严重报警', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const alarmService = new AlarmService();
    const alarm = alarmService.deviceDisconnected(1);
    assert.ok(alarm !== null);
    assert.strictEqual(alarm.alarm_type, ALARM_TYPES.DEVICE_DISCONNECTED);
    assert.strictEqual(alarm.level, ALARM_LEVELS.CRITICAL);
  } finally {
    cleanupTestDb();
  }
});

test('时间戳倒退应该产生报警', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const alarmService = new AlarmService();
    const now = Date.now();
    const previous = { timestamp: now, device_address: 1 };
    const current = { timestamp: now - 1000, device_address: 1, id: 1 };

    const alarm = alarmService.checkTimestamp(current, previous);
    assert.ok(alarm !== null);
    assert.strictEqual(alarm.alarm_type, ALARM_TYPES.TIMESTAMP_REVERSE);
  } finally {
    cleanupTestDb();
  }
});

test('相同类型报警应该有冷却时间', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const alarmService = new AlarmService();
    const alarm1 = alarmService.checkCorrosionRate(1, 1.0);
    const alarm2 = alarmService.checkCorrosionRate(1, 1.0);

    assert.ok(alarm1 !== null);
    assert.strictEqual(alarm2, null);
  } finally {
    cleanupTestDb();
  }
});

test('设备断开报警不应有冷却时间', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const alarmService = new AlarmService();
    const alarm1 = alarmService.deviceDisconnected(1);
    const alarm2 = alarmService.deviceDisconnected(1);

    assert.ok(alarm1 !== null);
    assert.ok(alarm2 !== null);
  } finally {
    cleanupTestDb();
  }
});

test('clearCooldown 应该清空冷却状态', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const alarmService = new AlarmService();
    alarmService.checkCorrosionRate(1, 1.0);
    alarmService.clearCooldown();
    const alarm = alarmService.checkCorrosionRate(1, 1.0);
    assert.ok(alarm !== null);
  } finally {
    cleanupTestDb();
  }
});

console.log('\n=== CSV 报告生成 ===');

test('应该生成 CSV 格式的报告', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      location: '测试位置',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      probeReadingRepo.create({
        device_address: 1,
        resistance: 100.0 + i * 0.01,
        temperature: 25.0 + i * 0.5,
        timestamp: now - (10 - i) * 60 * 1000,
        crc_valid: true
      });
    }

    const csv = generateCsvReport(1, now - 24 * 60 * 60 * 1000, now);

    assert.ok(csv.includes('设备信息'));
    assert.ok(csv.includes('数据记录'));
    assert.ok(csv.includes('腐蚀速率'));
    assert.ok(csv.includes('报警记录'));
    assert.ok(csv.includes('测试探针'));
  } finally {
    cleanupTestDb();
  }
});

test('应该包含 BOM 头以支持中文', () => {
  setupTestDb();
  try {
    deviceRepo.create({
      device_address: 1,
      name: '测试探针',
      initial_resistance: 100.0,
      k_factor: 1.0,
      alarm_threshold: 0.5
    });

    const now = Date.now();
    const csv = generateCsvReport(1, now - 86400000, now);

    assert.strictEqual(csv.charCodeAt(0), 0xFEFF);
  } finally {
    cleanupTestDb();
  }
});

test('设备不存在时应该抛出异常', () => {
  setupTestDb();
  try {
    const now = Date.now();
    assert.throws(() => generateCsvReport(999, now - 86400000, now), /设备不存在/);
  } finally {
    cleanupTestDb();
  }
});

console.log(`\n=== 测试结果: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  process.exit(1);
}
