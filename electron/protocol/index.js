const FRAME_HEADER = Buffer.from([0xAA, 0x55]);
const FRAME_TAIL = Buffer.from([0x0D, 0x0A]);
const FRAME_LENGTH = 18;
const MIN_TEMPERATURE = -40;
const MAX_TEMPERATURE = 150;

function crc16Modbus(buffer) {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc >>= 1;
        crc ^= 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc & 0xFFFF;
}

function parseFrame(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Input must be a Buffer');
  }

  if (buffer.length < FRAME_LENGTH) {
    throw new Error(`Frame too short: ${buffer.length} bytes, expected at least ${FRAME_LENGTH}`);
  }

  const header = buffer.slice(0, 2);
  if (!header.equals(FRAME_HEADER)) {
    throw new Error('Invalid frame header');
  }

  const tail = buffer.slice(buffer.length - 2, buffer.length);
  if (!tail.equals(FRAME_TAIL)) {
    throw new Error('Invalid frame tail');
  }

  const dataAndCrc = buffer.slice(2, buffer.length - 2);
  const dataPart = dataAndCrc.slice(0, dataAndCrc.length - 2);
  const receivedCrc = dataAndCrc.readUInt16LE(dataAndCrc.length - 2);
  const calculatedCrc = crc16Modbus(dataPart);
  const crcValid = receivedCrc === calculatedCrc;

  let offset = 0;
  const deviceAddress = dataPart.readUInt8(offset);
  offset += 1;

  const resistance = dataPart.readFloatLE(offset);
  offset += 4;

  const temperatureRaw = dataPart.readInt16LE(offset);
  const temperature = temperatureRaw / 10.0;
  offset += 2;

  const timestamp = dataPart.readUInt32LE(offset);
  offset += 4;

  const statusByte = dataPart.readUInt8(offset);
  offset += 1;

  const status = parseStatusByte(statusByte);

  return {
    device_address: deviceAddress,
    resistance: Math.round(resistance * 10000) / 10000,
    temperature: Math.round(temperature * 100) / 100,
    timestamp: timestamp * 1000,
    status_byte: statusByte,
    status,
    crc_valid: crcValid,
    raw_data: buffer
  };
}

function parseStatusByte(statusByte) {
  return {
    probe_ok: !(statusByte & 0x01),
    over_temp: !!(statusByte & 0x02),
    low_battery: !!(statusByte & 0x04),
    communication_error: !!(statusByte & 0x08),
    sensor_alarm: !!(statusByte & 0x10),
    reserved: (statusByte & 0xE0) >> 5
  };
}

function buildReadCommand(deviceAddress) {
  const cmd = Buffer.alloc(8);
  cmd[0] = 0xAA;
  cmd[1] = deviceAddress;
  cmd[2] = 0x01;
  cmd[3] = 0x00;
  cmd[4] = 0x00;
  cmd[5] = 0x00;

  const crc = crc16Modbus(cmd.slice(0, 6));
  cmd.writeUInt16LE(crc, 6);

  return cmd;
}

function temperatureCompensation(resistance, temperature, referenceTemp = 25, tempCoefficient = 0.00393) {
  if (temperature < MIN_TEMPERATURE || temperature > MAX_TEMPERATURE) {
    throw new Error(`Temperature out of valid range: ${temperature}°C (valid: ${MIN_TEMPERATURE}~${MAX_TEMPERATURE}°C)`);
  }
  const deltaT = temperature - referenceTemp;
  const compensatedResistance = resistance / (1 + tempCoefficient * deltaT);
  return Math.round(compensatedResistance * 10000) / 10000;
}

class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames = [];

    while (true) {
      const headerIndex = this.buffer.indexOf(FRAME_HEADER);
      if (headerIndex === -1) {
        this.buffer = Buffer.alloc(0);
        break;
      }

      if (headerIndex > 0) {
        this.buffer = this.buffer.slice(headerIndex);
      }

      if (this.buffer.length < FRAME_LENGTH) {
        break;
      }

      const tailIndex = this.buffer.indexOf(FRAME_TAIL, FRAME_LENGTH - 2);
      if (tailIndex === -1) {
        if (this.buffer.length > 1024) {
          this.buffer = this.buffer.slice(1);
          continue;
        }
        break;
      }

      const frameData = this.buffer.slice(0, tailIndex + 2);
      try {
        const parsed = parseFrame(frameData);
        frames.push(parsed);
      } catch (e) {
        frames.push({
          error: e.message,
          raw_data: frameData,
          crc_valid: false
        });
      }

      this.buffer = this.buffer.slice(tailIndex + 2);
    }

    return frames;
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }
}

function validateReading(reading, lastReading) {
  const errors = [];

  if (!reading.crc_valid) {
    errors.push('CRC校验失败');
  }

  if (reading.temperature < MIN_TEMPERATURE || reading.temperature > MAX_TEMPERATURE) {
    errors.push(`温度异常: ${reading.temperature}°C`);
  }

  if (reading.resistance <= 0) {
    errors.push(`电阻值异常: ${reading.resistance} mΩ`);
  }

  if (lastReading && reading.timestamp < lastReading.timestamp) {
    errors.push('时间戳倒退');
  }

  if (reading.status && !reading.status.probe_ok) {
    errors.push('探针状态异常');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  FRAME_HEADER,
  FRAME_TAIL,
  FRAME_LENGTH,
  MIN_TEMPERATURE,
  MAX_TEMPERATURE,
  crc16Modbus,
  parseFrame,
  parseStatusByte,
  buildReadCommand,
  temperatureCompensation,
  FrameParser,
  validateReading
};
