const assert = require('assert');
const {
  crc16Modbus,
  parseFrame,
  FrameParser,
  validateReading,
  temperatureCompensation,
  buildReadCommand,
  parseStatusByte,
  MIN_TEMPERATURE,
  MAX_TEMPERATURE,
  FRAME_HEADER,
  FRAME_TAIL
} = require('../electron/protocol');

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

function buildTestFrame(options = {}) {
  const deviceAddress = options.deviceAddress || 1;
  const resistance = options.resistance || 100.5;
  const temperature = options.temperature || 25.0;
  const timestamp = options.timestamp || Math.floor(Date.now() / 1000);
  const statusByte = options.statusByte || 0x00;
  const corruptCrc = options.corruptCrc || false;

  const dataPart = Buffer.alloc(12);
  let offset = 0;
  dataPart.writeUInt8(deviceAddress, offset++);
  dataPart.writeFloatLE(resistance, offset);
  offset += 4;
  dataPart.writeInt16LE(Math.round(temperature * 10), offset);
  offset += 2;
  dataPart.writeUInt32LE(timestamp, offset);
  offset += 4;
  dataPart.writeUInt8(statusByte, offset++);

  let crc = crc16Modbus(dataPart);
  if (corruptCrc) crc ^= 0xFFFF;

  return Buffer.concat([
    FRAME_HEADER,
    dataPart,
    Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF]),
    FRAME_TAIL
  ]);
}

console.log('\n=== CRC16 Modbus 校验 ===');

test('应该正确计算 CRC16 校验值', () => {
  const data = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0A]);
  const crc = crc16Modbus(data);
  assert.strictEqual(typeof crc, 'number');
  assert.ok(crc >= 0 && crc <= 0xFFFF);
  const crc2 = crc16Modbus(data);
  assert.strictEqual(crc, crc2);
});

test('空数据应该返回 0xFFFF', () => {
  const crc = crc16Modbus(Buffer.alloc(0));
  assert.strictEqual(crc, 0xFFFF);
});

test('相同数据应该产生相同 CRC', () => {
  const data = Buffer.from([0xAA, 0x01, 0x02, 0x03]);
  const crc1 = crc16Modbus(data);
  const crc2 = crc16Modbus(data);
  assert.strictEqual(crc1, crc2);
});

test('不同数据应该产生不同 CRC', () => {
  const data1 = Buffer.from([0xAA, 0x01, 0x02, 0x03]);
  const data2 = Buffer.from([0xAA, 0x01, 0x02, 0x04]);
  const crc1 = crc16Modbus(data1);
  const crc2 = crc16Modbus(data2);
  assert.notStrictEqual(crc1, crc2);
});

console.log('\n=== 协议帧解析 ===');

test('应该正确解析有效帧', () => {
  const frame = buildTestFrame({
    deviceAddress: 5,
    resistance: 120.345,
    temperature: 30.5,
    timestamp: 1700000000
  });

  const result = parseFrame(frame);

  assert.strictEqual(result.device_address, 5);
  assert.ok(Math.abs(result.resistance - 120.345) < 0.001);
  assert.ok(Math.abs(result.temperature - 30.5) < 0.01);
  assert.strictEqual(result.timestamp, 1700000000 * 1000);
  assert.strictEqual(result.status_byte, 0);
  assert.strictEqual(result.crc_valid, true);
});

test('应该检测 CRC 错误', () => {
  const frame = buildTestFrame({
    deviceAddress: 1,
    resistance: 100.0,
    temperature: 25.0,
    corruptCrc: true
  });

  const result = parseFrame(frame);
  assert.strictEqual(result.crc_valid, false);
});

test('帧头错误应该抛出异常', () => {
  const badFrame = Buffer.alloc(20);
  badFrame[0] = 0x00;
  badFrame[1] = 0x00;
  assert.throws(() => parseFrame(badFrame), /Invalid frame header/);
});

test('过短的帧应该抛出异常', () => {
  const shortFrame = Buffer.from([0xAA, 0x55, 0x01]);
  assert.throws(() => parseFrame(shortFrame), /Frame too short/);
});

test('应该正确解析状态字节', () => {
  const status = parseStatusByte(0x01);
  assert.strictEqual(status.probe_ok, false);

  const status2 = parseStatusByte(0x02);
  assert.strictEqual(status2.over_temp, true);

  const status3 = parseStatusByte(0x04);
  assert.strictEqual(status3.low_battery, true);

  const status4 = parseStatusByte(0x00);
  assert.strictEqual(status4.probe_ok, true);
  assert.strictEqual(status4.over_temp, false);
});

console.log('\n=== 流式帧解析器 FrameParser ===');

test('应该能从完整数据中解析帧', () => {
  const parser = new FrameParser();
  const frame = buildTestFrame({ deviceAddress: 3 });
  const frames = parser.feed(frame);

  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].device_address, 3);
  assert.strictEqual(frames[0].crc_valid, true);
});

test('应该能处理分块数据', () => {
  const parser = new FrameParser();
  const frame = buildTestFrame({ deviceAddress: 5 });
  const halfLen = Math.floor(frame.length / 2);

  const frames1 = parser.feed(frame.slice(0, halfLen));
  assert.strictEqual(frames1.length, 0);

  const frames2 = parser.feed(frame.slice(halfLen));
  assert.strictEqual(frames2.length, 1);
  assert.strictEqual(frames2[0].device_address, 5);
});

test('应该能连续解析多帧', () => {
  const parser = new FrameParser();
  const frame1 = buildTestFrame({ deviceAddress: 1 });
  const frame2 = buildTestFrame({ deviceAddress: 2 });
  const frame3 = buildTestFrame({ deviceAddress: 3 });

  const allData = Buffer.concat([frame1, frame2, frame3]);
  const frames = parser.feed(allData);

  assert.strictEqual(frames.length, 3);
  assert.strictEqual(frames[0].device_address, 1);
  assert.strictEqual(frames[1].device_address, 2);
  assert.strictEqual(frames[2].device_address, 3);
});

test('应该能处理 CRC 错误的帧并继续解析后续帧', () => {
  const parser = new FrameParser();
  const badFrame = buildTestFrame({ deviceAddress: 99, corruptCrc: true });
  const goodFrame = buildTestFrame({ deviceAddress: 10 });

  const allData = Buffer.concat([badFrame, goodFrame]);
  const frames = parser.feed(allData);

  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0].crc_valid, false);
  assert.strictEqual(frames[1].crc_valid, true);
  assert.strictEqual(frames[1].device_address, 10);
});

test('reset 应该清空缓冲区', () => {
  const parser = new FrameParser();
  const frame = buildTestFrame();
  parser.feed(frame.slice(0, 5));

  parser.reset();

  const result = parser.feed(frame);
  assert.strictEqual(result.length, 1);
});

console.log('\n=== 数据校验 validateReading ===');

function createReading(overrides = {}) {
  return {
    device_address: 1,
    resistance: 100.5,
    temperature: 25.0,
    timestamp: Date.now(),
    status_byte: 0,
    status: { probe_ok: true },
    crc_valid: true,
    ...overrides
  };
}

test('正常数据应该通过校验', () => {
  const reading = createReading();
  const result = validateReading(reading, null);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

test('CRC 错误应该被检测', () => {
  const reading = createReading({ crc_valid: false });
  const result = validateReading(reading, null);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('CRC校验失败'));
});

test('时间戳倒退应该被检测', () => {
  const now = Date.now();
  const previous = createReading({ timestamp: now });
  const current = createReading({ timestamp: now - 1000 });

  const result = validateReading(current, previous);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('时间戳倒退')));
});

test('温度超出范围应该被检测', () => {
  const reading = createReading({ temperature: 200 });
  const result = validateReading(reading, null);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('温度异常')));
});

test('负电阻应该被检测', () => {
  const reading = createReading({ resistance: -5 });
  const result = validateReading(reading, null);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('电阻值异常')));
});

test('探针故障应该被检测', () => {
  const reading = createReading({
    status: { probe_ok: false }
  });
  const result = validateReading(reading, null);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('探针状态异常'));
});

console.log('\n=== 温度补偿 ===');

test('参考温度下电阻应该不变', () => {
  const resistance = 100.0;
  const result = temperatureCompensation(resistance, 25, 25, 0.00393);
  assert.ok(Math.abs(result - 100.0) < 0.001);
});

test('高温下应该补偿减小电阻', () => {
  const resistance = 110.0;
  const result = temperatureCompensation(resistance, 50, 25, 0.00393);
  assert.ok(result < 110.0);
});

test('低温下应该补偿增大电阻', () => {
  const resistance = 90.0;
  const result = temperatureCompensation(resistance, 0, 25, 0.00393);
  assert.ok(result > 90.0);
});

test('温度超出范围应该抛出异常', () => {
  assert.throws(() => temperatureCompensation(100, -50), /Temperature out of valid range/);
  assert.throws(() => temperatureCompensation(100, 200), /Temperature out of valid range/);
});

test('边界温度值应该正常工作', () => {
  assert.doesNotThrow(() => temperatureCompensation(100, MIN_TEMPERATURE));
  assert.doesNotThrow(() => temperatureCompensation(100, MAX_TEMPERATURE));
});

console.log('\n=== 读取命令构建 ===');

test('应该构建正确的读取命令', () => {
  const cmd = buildReadCommand(1);
  assert.strictEqual(cmd.length, 8);
  assert.strictEqual(cmd[0], 0xAA);
  assert.strictEqual(cmd[1], 1);

  const dataPart = cmd.slice(0, 6);
  const receivedCrc = cmd.readUInt16LE(6);
  const calculatedCrc = crc16Modbus(dataPart);
  assert.strictEqual(receivedCrc, calculatedCrc);
});

test('不同地址应该产生不同命令', () => {
  const cmd1 = buildReadCommand(1);
  const cmd2 = buildReadCommand(2);
  assert.strictEqual(cmd1[1], 1);
  assert.strictEqual(cmd2[1], 2);
});

console.log(`\n=== 测试结果: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  process.exit(1);
}
