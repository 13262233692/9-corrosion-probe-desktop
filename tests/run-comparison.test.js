const assert = require('assert');
const path = require('path');
const fs = require('fs');

const tmpDbPath = path.join(process.cwd(), 'data', `test-group-${Date.now()}.db`);
try { fs.unlinkSync(tmpDbPath); } catch (e) {}

const {
  initDatabase,
  closeDatabase,
  deviceRepo,
  probeReadingRepo,
  probeGroupRepo,
  groupAlarmRuleRepo,
  alarmEventRepo
} = require('../electron/database');

initDatabase(tmpDbPath);

const {
  GroupComparisonService,
  RULE_TYPE_SPIKE,
  RULE_TYPE_DEVIATION,
  RULE_TYPE_MISSING_SAMPLES,
  RULE_TYPE_ABNORMAL_TEMP,
  GROUP_ALARM_COOLDOWN_MS
} = require('../electron/services/groupComparison');

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('\n=== 探针组 Repository 测试 ===');

test('probeGroupRepo 能创建和查询探针组', () => {
  const id = probeGroupRepo.create({
    name: '常减压塔顶',
    description: '常压塔5个测厚点',
    device_addresses: [1, 2, 3, 4, 5]
  });

  const group = probeGroupRepo.findById(id);
  assert.ok(group, '应该能查询到组');
  assert.strictEqual(group.name, '常减压塔顶');
  assert.deepStrictEqual(group.device_addresses, [1, 2, 3, 4, 5]);
  assert.strictEqual(group.enabled, 1);
});

test('probeGroupRepo 能更新组', () => {
  const id = probeGroupRepo.create({
    name: '组A',
    device_addresses: [1]
  });
  const changes = probeGroupRepo.update(id, {
    name: '组A修改',
    device_addresses: [1, 2, 3],
    enabled: 0
  });
  assert.strictEqual(changes, 1);
  const updated = probeGroupRepo.findById(id);
  assert.strictEqual(updated.name, '组A修改');
  assert.deepStrictEqual(updated.device_addresses, [1, 2, 3]);
  assert.strictEqual(updated.enabled, 0);
});

test('probeGroupRepo 能列出所有启用的组', () => {
  probeGroupRepo.create({ name: '启用A', device_addresses: [1], enabled: 1 });
  probeGroupRepo.create({ name: '禁用B', device_addresses: [1], enabled: 0 });
  probeGroupRepo.create({ name: '启用C', device_addresses: [1], enabled: 1 });

  const enabled = probeGroupRepo.findEnabled();
  for (const g of enabled) {
    assert.strictEqual(g.enabled, 1, `${g.name}应该是启用状态`);
  }
  assert.ok(enabled.length >= 2);
});

test('groupAlarmRuleRepo 能创建和查询规则', () => {
  const groupId = probeGroupRepo.create({
    name: '测试组1',
    device_addresses: [10, 11]
  });

  const ruleId1 = groupAlarmRuleRepo.create({
    group_id: groupId,
    rule_type: RULE_TYPE_SPIKE,
    threshold: 2.0,
    level: 'warning',
    window_hours: 24
  });

  const ruleId2 = groupAlarmRuleRepo.create({
    group_id: groupId,
    rule_type: RULE_TYPE_DEVIATION,
    threshold: 0.5,
    level: 'warning',
    window_hours: 24
  });

  const rules = groupAlarmRuleRepo.findByGroupId(groupId);
  assert.strictEqual(rules.length, 2);
  assert.strictEqual(rules[0].group_id, groupId);
});

console.log('\n=== 缺采样检测测试 ===');

testAsync('缺采样检测 - 当设备采样不足时触发预警', async () => {
  const addr1 = 100;
  const addr2 = 101;

  deviceRepo.create({
    device_address: addr1, name: '设备100', initial_resistance: 100, k_factor: 1
  });
  deviceRepo.create({
    device_address: addr2, name: '设备101', initial_resistance: 100, k_factor: 1
  });

  const groupId = probeGroupRepo.create({
    name: '缺采样测试组',
    device_addresses: [addr1, addr2]
  });

  groupAlarmRuleRepo.create({
    group_id: groupId,
    rule_type: RULE_TYPE_MISSING_SAMPLES,
    threshold: 3,
    level: 'info',
    window_hours: 24
  });

  const now = Date.now();
  const hours23 = now - 23 * 60 * 60 * 1000;
  const hours22 = now - 22 * 60 * 60 * 1000;
  const hours1 = now - 1 * 60 * 60 * 1000;

  probeReadingRepo.create({
    device_address: addr1, resistance: 100, temperature: 25,
    timestamp: hours23, crc_valid: 1
  });
  probeReadingRepo.create({
    device_address: addr1, resistance: 100.1, temperature: 25,
    timestamp: hours22, crc_valid: 1
  });

  probeReadingRepo.create({
    device_address: addr2, resistance: 100, temperature: 25,
    timestamp: hours1, crc_valid: 1
  });

  const svc = new GroupComparisonService();
  const result = svc.evaluateGroup(groupId);

  const missingResults = result.results.filter(r => r.rule_type === RULE_TYPE_MISSING_SAMPLES);
  assert.strictEqual(missingResults.length, 2, '应该产生2条缺采样检测结果（每个设备1条）');

  const missingAddrs = missingResults.map(r => r.device_address).sort();
  assert.deepStrictEqual(missingAddrs, [addr1, addr2].sort(), '缺采样结果应该包含两个设备地址');

  const r101 = missingResults.find(r => r.device_address === addr1);
  const r102 = missingResults.find(r => r.device_address === addr2);
  assert.strictEqual(r101.details[0].sample_count, 2, 'addr1 有2条样本，少于 threshold=3');
  assert.strictEqual(r102.details[0].sample_count, 1, 'addr2 有1条样本，少于 threshold=3');
});

console.log('\n=== 窗口样本不足测试 ===');

testAsync('窗口不足 - 只有1台设备有足够样本时跳过组偏差检测', async () => {
  const addr1 = 110;
  const addr2 = 111;

  deviceRepo.create({
    device_address: addr1, name: '设备110', initial_resistance: 100, k_factor: 1
  });
  deviceRepo.create({
    device_address: addr2, name: '设备111', initial_resistance: 100, k_factor: 1
  });

  const groupId = probeGroupRepo.create({
    name: '窗口不足测试',
    device_addresses: [addr1, addr2]
  });

  groupAlarmRuleRepo.create({
    group_id: groupId,
    rule_type: RULE_TYPE_DEVIATION,
    threshold: 0.5,
    level: 'warning',
    window_hours: 24
  });

  const now = Date.now();

  for (let i = 0; i < 3; i++) {
    probeReadingRepo.create({
      device_address: addr1, resistance: 100 + i * 0.1, temperature: 25,
      timestamp: now - (20 - i * 5) * 60 * 60 * 1000, crc_valid: 1
    });
  }

  for (let i = 0; i < 2; i++) {
    probeReadingRepo.create({
      device_address: addr2, resistance: 100 + i * 0.1, temperature: 25,
      timestamp: now - (20 - i * 5) * 60 * 60 * 1000, crc_valid: 1
    });
  }

  const svc = new GroupComparisonService();
  const result = svc.evaluateGroup(groupId);

  const deviation = result.results.find(r => r.rule_type === RULE_TYPE_DEVIATION);
  assert.ok(deviation, '应该有组偏差检测结果');
  assert.strictEqual(deviation.skipped, true, '因为样本不足，应该被跳过');
  assert.strictEqual(deviation.reason, '采样窗口不足');
  assert.ok(deviation.available_devices < 2);
});

console.log('\n=== 异常温度检测测试 ===');

testAsync('异常温度 - 温度超出范围时触发预警', async () => {
  const addr1 = 120;
  const addr2 = 121;

  deviceRepo.create({
    device_address: addr1, name: '设备120', initial_resistance: 100, k_factor: 1
  });
  deviceRepo.create({
    device_address: addr2, name: '设备121', initial_resistance: 100, k_factor: 1
  });

  const groupId = probeGroupRepo.create({
    name: '温度异常测试',
    device_addresses: [addr1, addr2]
  });

  groupAlarmRuleRepo.create({
    group_id: groupId,
    rule_type: RULE_TYPE_ABNORMAL_TEMP,
    threshold: 1,
    level: 'warning',
    window_hours: 24
  });

  const now = Date.now();
  const svc = new GroupComparisonService();
  svc.setTempRange(-20, 120);

  probeReadingRepo.create({
    device_address: addr1, resistance: 100, temperature: 25,
    timestamp: now - 2 * 60 * 60 * 1000, crc_valid: 1
  });
  probeReadingRepo.create({
    device_address: addr1, resistance: 100, temperature: 150,
    timestamp: now - 60 * 60 * 1000, crc_valid: 1
  });
  probeReadingRepo.create({
    device_address: addr1, resistance: 100.1, temperature: 26,
    timestamp: now, crc_valid: 1
  });

  probeReadingRepo.create({
    device_address: addr2, resistance: 100, temperature: -30,
    timestamp: now, crc_valid: 1
  });

  const result = svc.evaluateGroup(groupId);

  const tempResults = result.results.filter(r => r.rule_type === RULE_TYPE_ABNORMAL_TEMP);
  assert.strictEqual(tempResults.length, 2, '应该有2条温度异常结果（每台设备1条）');

  const temp120 = tempResults.find(r => r.device_address === addr1);
  const temp121 = tempResults.find(r => r.device_address === addr2);
  assert.ok(temp120, '设备120有超高温应该被检测');
  assert.ok(temp121, '设备121有超低温应该被检测');

  assert.ok(temp120.details[0].max_temp > 120, '设备120检测到的最高温应该超过120');
  assert.ok(temp121.details[0].min_temp < -20, '设备121检测到的最低温应该低于-20');
});

console.log('\n=== 报警去重（冷却时间）测试 ===');

testAsync('报警去重 - 同一规则在冷却时间内重复触发被去重', async () => {
  const addr1 = 130;
  const addr2 = 131;
  const addr3 = 132;

  deviceRepo.create({
    device_address: addr1, name: '设备130', initial_resistance: 100, k_factor: 1
  });
  deviceRepo.create({
    device_address: addr2, name: '设备131', initial_resistance: 100, k_factor: 1
  });
  deviceRepo.create({
    device_address: addr3, name: '设备132', initial_resistance: 100, k_factor: 1
  });

  const groupId = probeGroupRepo.create({
    name: '去重测试组',
    device_addresses: [addr1, addr2, addr3]
  });

  groupAlarmRuleRepo.create({
    group_id: groupId,
    rule_type: RULE_TYPE_DEVIATION,
    threshold: 0.2,
    level: 'warning',
    window_hours: 24
  });

  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;

  function injectReadings() {
    const dataPoints = 10;
    for (const [addr, rateMul] of [[addr1, 1], [addr2, 1.1], [addr3, 10]]) {
      for (let i = 0; i < dataPoints; i++) {
        const t = now - (dataPoints - i) * 2 * 60 * 60 * 1000;
        const res = 100 + rateMul * i * 0.06;
        probeReadingRepo.create({
          device_address: addr, resistance: res, temperature: 25,
          timestamp: t, crc_valid: 1
        });
      }
    }
  }

  injectReadings();
  const svc = new GroupComparisonService();

  const beforeCount = alarmEventRepo.findAll(1000, 0).length;

  const r1 = svc.evaluateGroup(groupId);
  const afterR1 = alarmEventRepo.findAll(1000, 0).length;
  const insertedFirst = afterR1 - beforeCount;
  assert.ok(insertedFirst >= 1, `第一次评估应该插入至少1条报警，实际插入${insertedFirst}`);

  const nonDeduped = r1.results.filter(r => !r.deduped);
  assert.ok(nonDeduped.length >= 1, '第一次应该有未去重的报警');

  const r2 = svc.evaluateGroup(groupId);
  const afterR2 = alarmEventRepo.findAll(1000, 0).length;
  const insertedSecond = afterR2 - afterR1;
  assert.strictEqual(insertedSecond, 0, `冷却时间内第二次不应该插入报警，实际插入${insertedSecond}`);

  const deduped = r2.results.filter(r => r.deduped);
  assert.ok(deduped.length >= 1, '第二次评估应该显示deduped标志');
});

testAsync('报警去重 - 不同设备相同规则不互相影响去重', async () => {
  const addr1 = 140;
  const addr2 = 141;

  deviceRepo.create({
    device_address: addr1, name: '设备140', initial_resistance: 100, k_factor: 1
  });
  deviceRepo.create({
    device_address: addr2, name: '设备141', initial_resistance: 100, k_factor: 1
  });

  const groupId = probeGroupRepo.create({
    name: '不同设备去重测试',
    device_addresses: [addr1, addr2]
  });

  groupAlarmRuleRepo.create({
    group_id: groupId,
    rule_type: RULE_TYPE_MISSING_SAMPLES,
    threshold: 100,
    level: 'info',
    window_hours: 24
  });

  const svc = new GroupComparisonService();
  const r = svc.evaluateGroup(groupId);

  const missResults = r.results.filter(x => x.rule_type === RULE_TYPE_MISSING_SAMPLES);
  assert.strictEqual(missResults.length, 2, '应该有2条缺采样结果（每台设备1条）');

  const missAddrs = missResults.map(x => x.device_address).sort();
  assert.deepStrictEqual(missAddrs, [addr1, addr2].sort(), '两台设备都缺采样');

  const key1 = `${groupId}:${RULE_TYPE_MISSING_SAMPLES}:${addr1}`;
  const key2 = `${groupId}:${RULE_TYPE_MISSING_SAMPLES}:${addr2}`;
  const status = svc.getCooldownStatus();

  const hasK1 = status.keys.some(k => k.key === key1);
  const hasK2 = status.keys.some(k => k.key === key2);
  assert.ok(hasK1, `设备${addr1}的去重key应该被登记`);
  assert.ok(hasK2, `设备${addr2}的去重key应该被登记`);
});

console.log('\n=== 速率突增检测测试 ===');

testAsync('速率突增 - 短窗口速率比长窗口高出阈值时触发', async () => {
  const addr = 150;
  deviceRepo.create({
    device_address: addr, name: '设备150', initial_resistance: 100, k_factor: 1
  });

  const groupId = probeGroupRepo.create({
    name: '突增测试组',
    device_addresses: [addr]
  });

  groupAlarmRuleRepo.create({
    group_id: groupId,
    rule_type: RULE_TYPE_SPIKE,
    threshold: 2.0,
    level: 'warning',
    window_hours: 24
  });

  const now = Date.now();
  const veryOld = now - 22 * 60 * 60 * 1000;
  const longAgo = now - 4 * 60 * 60 * 1000;
  const recent = now - 1 * 60 * 60 * 1000;

  probeReadingRepo.create({
    device_address: addr, resistance: 100.0, temperature: 25,
    timestamp: veryOld, crc_valid: 1
  });
  probeReadingRepo.create({
    device_address: addr, resistance: 100.05, temperature: 25,
    timestamp: longAgo, crc_valid: 1
  });
  probeReadingRepo.create({
    device_address: addr, resistance: 100.5, temperature: 25,
    timestamp: recent, crc_valid: 1
  });
  probeReadingRepo.create({
    device_address: addr, resistance: 102.0, temperature: 25,
    timestamp: now, crc_valid: 1
  });

  const svc = new GroupComparisonService();
  const result = svc.evaluateGroup(groupId);

  const spike = result.results.find(r => r.rule_type === RULE_TYPE_SPIKE);
  assert.ok(spike, '应该有速率突增检测结果');
  assert.ok(spike.ratio >= 2.0, `突增比率${spike.ratio}应该 >= 2.0`);
  assert.ok(spike.short_rate > spike.long_rate, '短窗口速率应该大于长窗口');
  assert.strictEqual(spike.device_address, addr);
});

console.log('\n=== 多设备速率对比与报告测试 ===');

testAsync('对比报告 - 能生成正确的对比结论', async () => {
  const addr1 = 160;
  const addr2 = 161;
  const addr3 = 162;

  deviceRepo.create({
    device_address: addr1, name: '设备160', initial_resistance: 100, k_factor: 1, alarm_threshold: 0.3
  });
  deviceRepo.create({
    device_address: addr2, name: '设备161', initial_resistance: 100, k_factor: 1, alarm_threshold: 0.3
  });
  deviceRepo.create({
    device_address: addr3, name: '设备162', initial_resistance: 100, k_factor: 1, alarm_threshold: 0.3
  });

  const now = Date.now();
  const dataPoints = 8;

  for (const [a, mul] of [[addr1, 0.005], [addr2, 0.006], [addr3, 1.0]]) {
    for (let i = 0; i < dataPoints; i++) {
      const t = now - (dataPoints - i) * 2 * 60 * 60 * 1000;
      const res = 100 + mul * i;
      probeReadingRepo.create({
        device_address: a, resistance: res, temperature: 25,
        timestamp: t, crc_valid: 1
      });
    }
  }

  const svc = new GroupComparisonService();
  const report = svc.generateComparisonReport([addr1, addr2, addr3], {
    windowHours: 24, alarmThreshold: 0.3
  });

  assert.strictEqual(report.summary.total_devices, 3);
  assert.strictEqual(report.summary.valid_devices, 3);
  assert.ok(report.summary.mean_rate > 0, '平均速率应该大于0');
  assert.ok(report.summary.max_rate > report.summary.min_rate, '最大速率大于最小');
  assert.strictEqual(report.summary.over_threshold_count, 1, '只有设备163超过阈值');
  assert.strictEqual(report.summary.fastest_device.device_address, addr3);
  assert.ok(report.conclusion.length > 0, '应该生成结论');
  assert.ok(report.conclusions.length >= 2, '至少2条结论');
  assert.ok(
    report.conclusion.includes('设备162') || report.conclusions.some(c => c.includes('162')),
    '结论中应该提到最高速设备'
  );
});

console.log(`\n=== 测试结果: ${passed} passed, ${failed} failed ===`);

try { fs.unlinkSync(tmpDbPath); } catch (e) {}

if (failed > 0) {
  process.exit(1);
}
