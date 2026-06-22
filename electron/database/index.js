const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function getElectronApp() {
  try {
    const electron = require('electron');
    return electron.app || null;
  } catch (e) {
    return null;
  }
}

function getDbPath() {
  const app = getElectronApp();
  const userDataPath = app ? app.getPath('userData') : process.cwd();
  const dbDir = path.join(userDataPath, 'data');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, 'corrosion-probe.db');
}

function initDatabase(dbPath) {
  if (db) return db;

  const actualPath = dbPath || getDbPath();
  db = new Database(actualPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  return db;
}

function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

const deviceRepo = {
  create(device) {
    const db = getDatabase();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO device 
      (device_address, name, location, probe_type, initial_resistance, k_factor, alarm_threshold, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      device.device_address,
      device.name,
      device.location || null,
      device.probe_type || null,
      device.initial_resistance || 0,
      device.k_factor || 1.0,
      device.alarm_threshold || 0.5,
      device.status || 'inactive',
      now,
      now
    );
    return result.lastInsertRowid;
  },

  findAll() {
    const db = getDatabase();
    return db.prepare('SELECT * FROM device ORDER BY device_address').all();
  },

  findByAddress(address) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM device WHERE device_address = ?').get(address);
  },

  update(address, updates) {
    const db = getDatabase();
    const now = Date.now();
    const fields = [];
    const values = [];
    
    for (const [key, val] of Object.entries(updates)) {
      if (key !== 'device_address' && key !== 'id') {
        fields.push(`${key} = ?`);
        values.push(val);
      }
    }
    fields.push('updated_at = ?');
    values.push(now);
    values.push(address);

    const stmt = db.prepare(`UPDATE device SET ${fields.join(', ')} WHERE device_address = ?`);
    return stmt.run(...values).changes;
  },

  delete(address) {
    const db = getDatabase();
    return db.prepare('DELETE FROM device WHERE device_address = ?').run(address).changes;
  }
};

const probeReadingRepo = {
  create(reading) {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO probe_reading 
      (device_address, resistance, temperature, timestamp, status_byte, crc_valid, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      reading.device_address,
      reading.resistance,
      reading.temperature,
      reading.timestamp,
      reading.status_byte || 0,
      reading.crc_valid ? 1 : 0,
      reading.raw_data || null
    );
    return result.lastInsertRowid;
  },

  findByDevice(deviceAddress, limit = 100, offset = 0) {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM probe_reading 
      WHERE device_address = ? 
      ORDER BY timestamp DESC 
      LIMIT ? OFFSET ?
    `).all(deviceAddress, limit, offset);
  },

  findByTimeRange(deviceAddress, startTime, endTime) {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM probe_reading 
      WHERE device_address = ? AND timestamp BETWEEN ? AND ?
      ORDER BY timestamp ASC
    `).all(deviceAddress, startTime, endTime);
  },

  findLatest(deviceAddress) {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM probe_reading 
      WHERE device_address = ? 
      ORDER BY timestamp DESC LIMIT 1
    `).get(deviceAddress);
  }
};

const corrosionRateRepo = {
  create(rate) {
    const db = getDatabase();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO corrosion_rate 
      (device_address, rate, unit, window_start, window_end, sample_count, calculated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      rate.device_address,
      rate.rate,
      rate.unit || 'mm/y',
      rate.window_start,
      rate.window_end,
      rate.sample_count,
      now
    );
    return result.lastInsertRowid;
  },

  findByDevice(deviceAddress, limit = 50) {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM corrosion_rate 
      WHERE device_address = ? 
      ORDER BY calculated_at DESC 
      LIMIT ?
    `).all(deviceAddress, limit);
  },

  findLatest(deviceAddress) {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM corrosion_rate 
      WHERE device_address = ? 
      ORDER BY calculated_at DESC LIMIT 1
    `).get(deviceAddress);
  }
};

const alarmEventRepo = {
  create(alarm) {
    const db = getDatabase();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO alarm_event 
      (device_address, alarm_type, level, message, reading_id, corrosion_rate_id, acknowledged, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      alarm.device_address,
      alarm.alarm_type,
      alarm.level,
      alarm.message,
      alarm.reading_id || null,
      alarm.corrosion_rate_id || null,
      0,
      now
    );
    return result.lastInsertRowid;
  },

  findAll(limit = 100, offset = 0) {
    const db = getDatabase();
    return db.prepare(`
      SELECT a.*, d.name as device_name 
      FROM alarm_event a
      LEFT JOIN device d ON a.device_address = d.device_address
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  },

  findUnacknowledged() {
    const db = getDatabase();
    return db.prepare(`
      SELECT a.*, d.name as device_name 
      FROM alarm_event a
      LEFT JOIN device d ON a.device_address = d.device_address
      WHERE acknowledged = 0
      ORDER BY created_at DESC
    `).all();
  },

  acknowledge(id) {
    const db = getDatabase();
    return db.prepare('UPDATE alarm_event SET acknowledged = 1 WHERE id = ?').run(id).changes;
  }
};

const configRepo = {
  get(key, defaultValue = null) {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : defaultValue;
  },

  set(key, value) {
    const db = getDatabase();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO app_config (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    stmt.run(key, JSON.stringify(value), now);
    return true;
  }
};

const probeGroupRepo = {
  create(group) {
    const db = getDatabase();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO probe_group 
      (name, description, device_addresses, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const addresses = Array.isArray(group.device_addresses) 
      ? JSON.stringify(group.device_addresses) 
      : group.device_addresses;
    const result = stmt.run(
      group.name,
      group.description || null,
      addresses,
      group.enabled !== undefined ? (group.enabled ? 1 : 0) : 1,
      now,
      now
    );
    return result.lastInsertRowid;
  },

  findAll() {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM probe_group ORDER BY created_at DESC').all();
    return rows.map(r => ({
      ...r,
      device_addresses: JSON.parse(r.device_addresses)
    }));
  },

  findById(id) {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM probe_group WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      device_addresses: JSON.parse(row.device_addresses)
    };
  },

  findEnabled() {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM probe_group WHERE enabled = 1 ORDER BY created_at DESC').all();
    return rows.map(r => ({
      ...r,
      device_addresses: JSON.parse(r.device_addresses)
    }));
  },

  update(id, updates) {
    const db = getDatabase();
    const now = Date.now();
    const fields = [];
    const values = [];

    for (const [key, val] of Object.entries(updates)) {
      if (key !== 'id') {
        fields.push(`${key} = ?`);
        if (key === 'device_addresses' && Array.isArray(val)) {
          values.push(JSON.stringify(val));
        } else if (key === 'enabled') {
          values.push(val ? 1 : 0);
        } else {
          values.push(val);
        }
      }
    }
    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const stmt = db.prepare(`UPDATE probe_group SET ${fields.join(', ')} WHERE id = ?`);
    return stmt.run(...values).changes;
  },

  delete(id) {
    const db = getDatabase();
    db.prepare('DELETE FROM group_alarm_rule WHERE group_id = ?').run(id);
    return db.prepare('DELETE FROM probe_group WHERE id = ?').run(id).changes;
  }
};

const groupAlarmRuleRepo = {
  create(rule) {
    const db = getDatabase();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO group_alarm_rule 
      (group_id, rule_type, threshold, level, window_hours, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      rule.group_id,
      rule.rule_type,
      rule.threshold,
      rule.level || 'warning',
      rule.window_hours || 24,
      rule.enabled !== undefined ? (rule.enabled ? 1 : 0) : 1,
      now,
      now
    );
    return result.lastInsertRowid;
  },

  findAll() {
    const db = getDatabase();
    return db.prepare(`
      SELECT r.*, g.name as group_name 
      FROM group_alarm_rule r
      LEFT JOIN probe_group g ON r.group_id = g.id
      ORDER BY r.created_at DESC
    `).all();
  },

  findByGroupId(groupId) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM group_alarm_rule WHERE group_id = ? ORDER BY created_at DESC').all(groupId);
  },

  findEnabledByGroupId(groupId) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM group_alarm_rule WHERE group_id = ? AND enabled = 1 ORDER BY created_at DESC').all(groupId);
  },

  findEnabled() {
    const db = getDatabase();
    return db.prepare(`
      SELECT r.*, g.name as group_name, g.device_addresses
      FROM group_alarm_rule r
      LEFT JOIN probe_group g ON r.group_id = g.id
      WHERE r.enabled = 1 AND g.enabled = 1
      ORDER BY r.created_at DESC
    `).all().map(r => ({
      ...r,
      device_addresses: JSON.parse(r.device_addresses)
    }));
  },

  update(id, updates) {
    const db = getDatabase();
    const now = Date.now();
    const fields = [];
    const values = [];

    for (const [key, val] of Object.entries(updates)) {
      if (key !== 'id') {
        fields.push(`${key} = ?`);
        if (key === 'enabled') {
          values.push(val ? 1 : 0);
        } else {
          values.push(val);
        }
      }
    }
    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const stmt = db.prepare(`UPDATE group_alarm_rule SET ${fields.join(', ')} WHERE id = ?`);
    return stmt.run(...values).changes;
  },

  delete(id) {
    const db = getDatabase();
    return db.prepare('DELETE FROM group_alarm_rule WHERE id = ?').run(id).changes;
  }
};

module.exports = {
  initDatabase,
  getDatabase,
  closeDatabase,
  deviceRepo,
  probeReadingRepo,
  corrosionRateRepo,
  alarmEventRepo,
  configRepo,
  probeGroupRepo,
  groupAlarmRuleRepo
};
