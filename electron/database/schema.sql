CREATE TABLE IF NOT EXISTS device (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_address INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  location TEXT,
  probe_type TEXT,
  initial_resistance REAL NOT NULL DEFAULT 0,
  k_factor REAL NOT NULL DEFAULT 1.0,
  alarm_threshold REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'inactive',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_reading (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_address INTEGER NOT NULL,
  resistance REAL NOT NULL,
  temperature REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  status_byte INTEGER NOT NULL DEFAULT 0,
  crc_valid INTEGER NOT NULL DEFAULT 1,
  raw_data BLOB,
  FOREIGN KEY (device_address) REFERENCES device(device_address)
);

CREATE INDEX IF NOT EXISTS idx_probe_reading_device_time 
  ON probe_reading(device_address, timestamp DESC);

CREATE TABLE IF NOT EXISTS corrosion_rate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_address INTEGER NOT NULL,
  rate REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'mm/y',
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  calculated_at INTEGER NOT NULL,
  FOREIGN KEY (device_address) REFERENCES device(device_address)
);

CREATE INDEX IF NOT EXISTS idx_corrosion_rate_device_time 
  ON corrosion_rate(device_address, calculated_at DESC);

CREATE TABLE IF NOT EXISTS alarm_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_address INTEGER NOT NULL,
  alarm_type TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  reading_id INTEGER,
  corrosion_rate_id INTEGER,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (device_address) REFERENCES device(device_address)
);

CREATE INDEX IF NOT EXISTS idx_alarm_event_device_time 
  ON alarm_event(device_address, created_at DESC);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
