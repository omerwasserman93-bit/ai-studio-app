import fs from 'fs';
import path from 'path';

export interface UserConfig {
  email: string;
  thresholdTime: string; // e.g., "11:00"
  delayHours: number; // e.g., 2
  googleClientId?: string;
  googleClientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  tokenExpiry?: number;
}

export interface AlarmLog {
  id: string;
  email: string;
  date: string; // "YYYY-MM-DD"
  firstEventTitle?: string;
  firstEventStart?: string;
  thresholdTime: string;
  delayHours: number;
  computedAlarm?: string; // "HH:MM"
  status: 'ALARM_SET' | 'NO_EVENTS' | 'AFTER_THRESHOLD' | 'ERROR';
  errorMessage?: string;
  timestamp: string;
}

interface DatabaseSchema {
  configs: { [email: string]: UserConfig };
  logs: AlarmLog[];
}

const DB_FILE = path.join(process.cwd(), 'db.json');

function initDb(): DatabaseSchema {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf-8');
      return JSON.parse(data) as DatabaseSchema;
    }
  } catch (error) {
    console.error('Error reading db.json, returning empty database', error);
  }
  
  const defaultDb: DatabaseSchema = {
    configs: {},
    logs: []
  };
  saveDb(defaultDb);
  return defaultDb;
}

function saveDb(data: DatabaseSchema) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error writing to db.json', error);
  }
}

export const dbService = {
  getUserConfig(email: string): UserConfig {
    const db = initDb();
    // Return standard defaults if no custom config exists yet
    return db.configs[email.toLowerCase()] || {
      email: email.toLowerCase(),
      thresholdTime: '11:00',
      delayHours: 2,
    };
  },

  saveUserConfig(config: UserConfig): void {
    const db = initDb();
    db.configs[config.email.toLowerCase()] = {
      ...this.getUserConfig(config.email),
      ...config,
      email: config.email.toLowerCase(),
    };
    saveDb(db);
  },

  getLogs(email: string): AlarmLog[] {
    const db = initDb();
    return db.logs
      .filter(log => log.email.toLowerCase() === email.toLowerCase())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  },

  addLog(log: Omit<AlarmLog, 'id' | 'timestamp'>): AlarmLog {
    const db = initDb();
    const newLog: AlarmLog = {
      ...log,
      id: Math.random().toString(36).substring(2, 11),
      timestamp: new Date().toISOString()
    };
    db.logs.push(newLog);
    // Keep logs size contained (e.g. limit to last 200 logs total)
    if (db.logs.length > 500) {
      db.logs = db.logs.slice(-200);
    }
    saveDb(db);
    return newLog;
  }
};
