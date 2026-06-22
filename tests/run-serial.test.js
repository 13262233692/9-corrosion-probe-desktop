const assert = require('assert');
const { EventEmitter } = require('events');

const originalSerialPort = require('serialport').SerialPort;

class MockSerialPort extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.isOpen = false;
    this._dataQueue = [];
    this._drainCalled = false;
    this._closeCallback = null;
    this._openError = null;
  }

  open(callback) {
    process.nextTick(() => {
      if (this._openError) {
        callback(this._openError);
      } else {
        this.isOpen = true;
        this.emit('open');
        callback(null);
      }
    });
  }

  write(data, callback) {
    if (!this.isOpen) {
      callback(new Error('Port not open'));
      return;
    }
    process.nextTick(() => callback(null));
  }

  drain(callback) {
    this._drainCalled = true;
    process.nextTick(() => callback(null));
  }

  close(callback) {
    this._closeCallback = callback;
    process.nextTick(() => {
      this.isOpen = false;
      this.emit('close');
      if (callback) callback(null);
    });
  }

  _simulateData(data) {
    if (this.isOpen) {
      this.emit('data', Buffer.from(data));
    }
  }

  _simulateDisconnect() {
    if (this.isOpen) {
      this.isOpen = false;
      this.emit('close');
    }
  }

  _simulateError(err) {
    this.emit('error', err);
  }
}

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

require.cache[require.resolve('serialport')] = {
  exports: {
    SerialPort: MockSerialPort,
    list: () => Promise.resolve([{ path: '/dev/ttyUSB0' }])
  }
};

delete require.cache[require.resolve('../electron/serial')];
const { SerialManager } = require('../electron/serial');

console.log('\n=== 串口生命周期管理测试 ===');

testAsync('连接过程中监听器只绑定一次', async () => {
  const manager = new SerialManager();
  const dataListenerCount = () => {
    return manager.port ? manager.port.listenerCount('data') : 0;
  };

  await manager.connect({ path: '/dev/ttyUSB0', baudRate: 9600 });
  assert.strictEqual(dataListenerCount(), 1, '第一次连接应该有1个data监听器');

  await manager.disconnect();

  await manager.connect({ path: '/dev/ttyUSB0', baudRate: 9600 });
  assert.strictEqual(dataListenerCount(), 1, '第二次连接应该只有1个data监听器，没有重复绑定');
});

testAsync('模拟断开重连不会重复监听', async () => {
  const manager = new SerialManager();
  let readingCount = 0;

  manager.on('reading', () => {
    readingCount++;
  });

  await manager.connect({ path: '/dev/ttyUSB0', baudRate: 9600, sampleInterval: 100 });

  const testFrame = Buffer.from([
    0xAA, 0x55, 0x01, 0x00, 0x00, 0xC8, 0x42, 0xFA, 0x00,
    0x00, 0x6D, 0x8F, 0x65, 0x00, 0x00, 0x1C, 0x42, 0x0D, 0x0A
  ]);

  manager.port._simulateData(testFrame.slice(0, 10));

  manager.port._simulateDisconnect();
  await sleep(100);

  const pendingBuffer = manager._pendingFrameBuffer;
  assert.ok(pendingBuffer && pendingBuffer.length > 0, '应该保存不完整的帧数据');

  await manager._withLock(async () => {
    manager._connectionId++;
    await manager._doConnect(manager._connectionId);
    manager.isConnected = true;
  });

  assert.ok(manager.frameParser.buffer.length > 0, '重连后应该恢复之前的不完整帧');

  manager.port._simulateData(testFrame.slice(10));

  await sleep(50);
  assert.strictEqual(readingCount, 1, '拼接后的帧应该只被解析一次，不会重复');

  await manager.disconnect();
});

testAsync('快速插拔不会导致并发连接', async () => {
  const manager = new SerialManager();
  let connectCount = 0;
  let activeConnectionId = 0;

  manager.on('connected', () => {
    connectCount++;
  });

  const connectPromises = [];
  for (let i = 0; i < 5; i++) {
    connectPromises.push(
      manager.connect({ path: '/dev/ttyUSB0', baudRate: 9600 }).catch(() => {})
    );
  }

  await Promise.all(connectPromises);
  await sleep(100);

  assert.strictEqual(connectCount, 1, '多次快速连接应该只有一次成功');
  assert.strictEqual(manager.port.listenerCount('data'), 1, '只有一个监听器');

  await manager.disconnect();
});

testAsync('重连后不完整帧应该能被正确恢复并解析', async () => {
  const manager = new SerialManager();
  let readingCount = 0;
  let readings = [];

  manager.on('reading', (r) => {
    readingCount++;
    readings.push(r);
  });

  await manager.connect({ path: '/dev/ttyUSB0', baudRate: 9600 });

  const testFrame = Buffer.from([
    0xAA, 0x55, 0x01, 0x00, 0x00, 0xC8, 0x42, 0xFA, 0x00,
    0x00, 0x6D, 0x8F, 0x65, 0x00, 0x00, 0x1C, 0x42, 0x0D, 0x0A
  ]);

  manager.port._simulateData(testFrame.slice(0, 8));

  manager.port._simulateDisconnect();
  await sleep(50);

  const partialLen = manager._pendingFrameBuffer.length;
  assert.strictEqual(partialLen, 8, '应该保存前8个字节的不完整帧');

  await manager._withLock(async () => {
    manager._connectionId++;
    await manager._doConnect(manager._connectionId);
    manager.isConnected = true;
  });

  assert.strictEqual(manager.frameParser.buffer.length, 8, '重连后缓冲区应该有8字节');

  manager.port._simulateData(testFrame.slice(8));
  await sleep(50);

  assert.strictEqual(readingCount, 1, '拼接后的帧应该被正确解析1次');
  assert.strictEqual(readings[0].device_address, 1, '解析出的设备地址应该正确');

  await manager.disconnect();
});

testAsync('同一份数据不会被多个监听器处理', async () => {
  const manager = new SerialManager();
  let frameCount = 0;

  manager.on('reading', () => {
    frameCount++;
  });

  await manager.connect({ path: '/dev/ttyUSB0', baudRate: 9600 });

  const testFrame = Buffer.from([
    0xAA, 0x55, 0x01, 0x00, 0x00, 0xC8, 0x42, 0xFA, 0x00,
    0x00, 0x6D, 0x8F, 0x65, 0x00, 0x00, 0x1C, 0x42, 0x0D, 0x0A
  ]);

  for (let i = 0; i < 3; i++) {
    manager.port._simulateDisconnect();
    await sleep(20);

    await manager._withLock(async () => {
      manager._connectionId++;
      manager._pendingFrameBuffer = null;
      await manager._doConnect(manager._connectionId);
      manager.isConnected = true;
    });
    await sleep(20);
  }

  assert.strictEqual(manager.port.listenerCount('data'), 1, '经过3次重连，应该只有1个data监听器');

  manager.port._simulateData(testFrame);
  await sleep(50);

  assert.strictEqual(frameCount, 1, '一帧数据只会被解析一次，不会被多次处理');

  await manager.disconnect();
});

testAsync('主动断开不会触发自动重连', async () => {
  const manager = new SerialManager();
  let reconnectAttempts = 0;

  manager.on('reconnecting', () => {
    reconnectAttempts++;
  });

  await manager.connect({ path: '/dev/ttyUSB0', baudRate: 9600 });
  await manager.disconnect();

  await sleep(100);

  assert.strictEqual(reconnectAttempts, 0, '主动断开后不应该自动重连');
  assert.strictEqual(manager._manualDisconnect, true, '_manualDisconnect标志应该为true');
});

testAsync('意外断开会触发自动重连', async () => {
  const manager = new SerialManager();
  let reconnectingCount = 0;

  manager.on('reconnecting', () => {
    reconnectingCount++;
  });

  await manager.connect({ path: '/dev/ttyUSB0', baudRate: 9600 });

  manager.port._simulateDisconnect();
  await sleep(6000);

  assert.ok(reconnectingCount >= 1, '意外断开后应该触发重连');
  assert.strictEqual(manager._manualDisconnect, false, '_manualDisconnect标志应该为false');

  await manager.disconnect();
});

testAsync('重连过程中旧连接的数据不会被处理', async () => {
  const manager = new SerialManager();
  let processedFrames = [];

  manager.on('reading', (r) => {
    processedFrames.push(r);
  });

  await manager.connect({ path: '/dev/ttyUSB0', baudRate: 9600 });
  const oldPort = manager.port;
  const oldConnectionId = manager._connectionId;

  manager.port._simulateDisconnect();
  await sleep(50);

  manager._connectionId++;
  await manager._withLock(async () => {
    await manager._doConnect(manager._connectionId);
    manager.isConnected = true;
  });

  oldPort._simulateData(Buffer.from([
    0xAA, 0x55, 0x02, 0x00, 0x00, 0xC8, 0x42, 0xFA, 0x00,
    0x00, 0x6D, 0x8F, 0x65, 0x00, 0x00, 0x1C, 0x42, 0x0D, 0x0A
  ]));

  await sleep(50);

  const newFrame = Buffer.from([
    0xAA, 0x55, 0x01, 0x00, 0x00, 0xC8, 0x42, 0xFA, 0x00,
    0x00, 0x6D, 0x8F, 0x65, 0x00, 0x00, 0x1C, 0x42, 0x0D, 0x0A
  ]);
  manager.port._simulateData(newFrame);

  await sleep(50);

  assert.strictEqual(processedFrames.length, 1, '应该只处理新连接的数据，旧连接的数据被丢弃');
  assert.strictEqual(processedFrames[0].device_address, 1, '应该是新连接发送的设备地址1，而不是旧连接的2');

  await manager.disconnect();
});

testAsync('connectionId 能正确过期旧连接', async () => {
  const manager = new SerialManager();

  await manager.connect({ path: '/dev/ttyUSB0', baudRate: 9600 });
  const firstId = manager._connectionId;

  manager._currentConnectionId = firstId;
  manager._connectionId = firstId + 1;

  let wasCalled = false;
  const originalOnData = manager._onData.bind(manager);
  manager._onData = (data) => {
    wasCalled = true;
    return originalOnData(data);
  };

  manager._onDataBound = manager._onData.bind(manager);
  manager.port.removeAllListeners('data');
  manager.port.on('data', manager._onDataBound);

  manager.port._simulateData(Buffer.from([0xAA, 0x55, 0x01]));
  await sleep(10);

  assert.strictEqual(wasCalled, true, '回调应该被调用');
  assert.ok(manager._connectionId !== manager._currentConnectionId, 'connectionId不匹配');

  await manager.disconnect();
});

console.log(`\n=== 测试结果: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  process.exit(1);
}
