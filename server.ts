import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { dbService, UserConfig } from './server_db.js';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Enable CORS for testing companion automation
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-User-Email');
  next();
});

// Help endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Save or Update configuration
app.post('/api/settings', (req, res) => {
  const { email, thresholdTime, delayHours, googleClientId, googleClientSecret } = req.body;
  if (!email) {
    res.status(400).json({ error: 'Email is required.' });
    return;
  }

  const currentConfig = dbService.getUserConfig(email);
  const updatedConfig: UserConfig = {
    ...currentConfig,
    email: email.toLowerCase(),
    thresholdTime: thresholdTime || currentConfig.thresholdTime,
    delayHours: typeof delayHours === 'number' ? delayHours : currentConfig.delayHours,
    googleClientId: googleClientId !== undefined ? googleClientId : currentConfig.googleClientId,
    googleClientSecret: googleClientSecret !== undefined ? googleClientSecret : currentConfig.googleClientSecret,
  };

  dbService.saveUserConfig(updatedConfig);
  res.json({ message: 'Settings saved successfully', config: updatedConfig });
});

// Fetch configuration
app.get('/api/settings', (req, res) => {
  const email = req.query.email as string;
  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }
  const config = dbService.getUserConfig(email);
  res.json({
    email: config.email,
    thresholdTime: config.thresholdTime,
    delayHours: config.delayHours,
    hasClientConfig: !!config.googleClientId && !!config.googleClientSecret,
    googleClientId: config.googleClientId || '',
    googleClientSecret: config.googleClientSecret ? '••••••••••••••••' : '',
    isGoogleConnected: !!config.refreshToken,
  });
});

// Fetch activity logs
app.get('/api/logs', (req, res) => {
  const email = req.query.email as string;
  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }
  const logs = dbService.getLogs(email);
  res.json(logs);
});

// 1. Generate Google OAuth Authorization URL
app.get('/api/auth/url', (req, res) => {
  const email = req.query.email as string;
  const redirectUri = req.query.redirectUri as string;
  
  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }
  if (!redirectUri) {
    res.status(400).json({ error: 'Redirect URI is required' });
    return;
  }

  const config = dbService.getUserConfig(email);
  const clientId = config.googleClientId || process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    res.status(400).json({ error: 'Google Client ID is not configured. Please enter it in the settings.' });
    return;
  }

  const stateObj = { email: email.toLowerCase(), redirectUri };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events.readonly',
    access_type: 'offline',
    prompt: 'consent', // Force refresh_token on every connection
    state: state,
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  res.json({ url: authUrl });
});

// 2. Google OAuth Callback
app.get(['/auth/callback', '/auth/callback/'], async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #0f172a; color: #f8fafc;">
          <h2 style="color: #ef4444;">OAuth Error</h2>
          <p>Missing auth code or state from Google. Try connecting again.</p>
          <button onclick="window.close()" style="margin-top:20px; padding: 10px 20px; background:#ef4444; border:none; color:white; border-radius:5px; cursor:pointer;">Close Window</button>
        </body>
      </html>
    `);
    return;
  }

  try {
    // Decode state
    const stateStr = Buffer.from(state as string, 'base64').toString('utf-8');
    const { email, redirectUri } = JSON.parse(stateStr);

    const config = dbService.getUserConfig(email);
    const clientId = config.googleClientId || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth credentials not configured completely on the server.');
    }

    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code as string,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Google Token token endpoint returned error: ${errorText}`);
    }

    const tokenData = (await tokenResponse.json()) as any;
    
    // Save tokens in local DB
    dbService.saveUserConfig({
      email,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || config.refreshToken, // Google only sends refresh_token if prompt=consent
      tokenExpiry: Date.now() + (tokenData.expires_in * 1000),
      thresholdTime: config.thresholdTime,
      delayHours: config.delayHours,
    });

    // Notify parent frame and close popup
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #0f172a; color: #f8fafc;">
          <svg style="color: #10b981; width: 64px; height: 64px;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <h2 style="color: #10b981; margin-top:20px;">Connection Successful!</h2>
          <p>Your Google Calendar is now securely linked to Smart Alarm.</p>
          <p style="color: #94a3b8; font-size:14px;">This window will close automatically shortly.</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', email: "${email}" }, '*');
              setTimeout(() => { window.close(); }, 1500);
            } else {
              window.location.href = '/';
            }
          </script>
        </body>
      </html>
    `);
  } catch (error: any) {
    console.error('OAuth Exchange Error:', error);
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #0f172a; color: #f8fafc;">
          <h2 style="color: #ef4444;">Exchange Error</h2>
          <p>${error.message || error}</p>
          <button onclick="window.close()" style="margin-top:20px; padding: 10px 20px; background:#ef4444; border:none; color:white; border-radius:5px; cursor:pointer;">Close Window</button>
        </body>
      </html>
    `);
  }
});

// Helper to refresh access token if needed
async function getOrRefreshAccessToken(config: UserConfig): Promise<string> {
  if (!config.refreshToken) {
    throw new Error('Google account is not connected. Use the dashboard to authorize.');
  }

  // If token is still valid (with 2-minute margin)
  if (config.accessToken && config.tokenExpiry && config.tokenExpiry > Date.now() + 120000) {
    return config.accessToken;
  }

  console.log(`Refreshing access token for user: ${config.email}`);
  const clientId = config.googleClientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Google client credentials are not configured.');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to refresh token: ${errText}`);
  }

  const data = (await response.json()) as any;
  const newAccessToken = data.access_token;
  const newExpiry = Date.now() + (data.expires_in * 1000);

  dbService.saveUserConfig({
    ...config,
    accessToken: newAccessToken,
    tokenExpiry: newExpiry,
  });

  return newAccessToken;
}

// 3. Main Companion API Endpoint - Fetches alarm configuration for next automated set
// Highly compliant with Android automation apps (Tasker, MacroDroid)
app.get('/api/alarm/next', async (req, res) => {
  const email = (req.query.email as string || req.headers['x-user-email'] as string);
  
  if (!email) {
    res.status(400).json({ error: 'Email parameter (or X-User-Email header) is required.' });
    return;
  }

  const config = dbService.getUserConfig(email);
  if (!config.refreshToken) {
    res.status(400).json({
      error: 'Google account not connected',
      needs_auth: true,
      status: 'ERROR',
    });
    return;
  }

  try {
    const accessToken = await getOrRefreshAccessToken(config);
    
    // We analyze the calendar starting from today's start till end of today/early tomorrow.
    // At 1:00 AM daily check, we query events for the rest of THAT current day (today).
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    
    const params = new URLSearchParams({
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
    });

    const calendarResponse = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!calendarResponse.ok) {
      const errTxt = await calendarResponse.text();
      throw new Error(`Google Calendar API error: ${errTxt}`);
    }

    const calendarData = (await calendarResponse.json()) as any;
    const rawEvents = calendarData.items || [];
    
    // Filter actual events (exclude all-day events since they don't have start times with hours, and exclude cancelled events)
    const timedEvents = rawEvents.filter((event: any) => {
      return event.status !== 'cancelled' && event.start && event.start.dateTime;
    });

    const logDateStr = now.toISOString().split('T')[0];

    if (timedEvents.length === 0) {
      // Add log
      dbService.addLog({
        email: config.email,
        date: logDateStr,
        thresholdTime: config.thresholdTime,
        delayHours: config.delayHours,
        computedAlarm: undefined,
        status: 'NO_EVENTS'
      });

      res.json({
        has_alarm: false,
        alarm_time: null,
        status: 'NO_EVENTS',
        message: 'No timed events found in calendar for today.',
        events_count: 0
      });
      return;
    }

    // Capture first event of the day
    const firstEvent = timedEvents[0];
    const eventBeginTimeStr = firstEvent.start.dateTime; // ISO dateTime: "2026-06-20T09:00:00-07:00"
    const firstEventStart = new Date(eventBeginTimeStr);
    
    // Check threshold
    const [threshHour, threshMinute] = config.thresholdTime.split(':').map(Number);
    const thresholdDateObj = new Date(firstEventStart.getFullYear(), firstEventStart.getMonth(), firstEventStart.getDate(), threshHour, threshMinute, 0, 0);

    if (firstEventStart >= thresholdDateObj) {
      // Add log
      dbService.addLog({
        email: config.email,
        date: logDateStr,
        firstEventTitle: firstEvent.summary || 'No Title',
        firstEventStart: firstEventStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        thresholdTime: config.thresholdTime,
        delayHours: config.delayHours,
        computedAlarm: undefined,
        status: 'AFTER_THRESHOLD'
      });

      res.json({
        has_alarm: false,
        alarm_time: null,
        status: 'AFTER_THRESHOLD',
        message: `First event begins at ${firstEventStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}, which is after the threshold time of ${config.thresholdTime}.`,
        first_event_title: firstEvent.summary || 'No Title'
      });
      return;
    }

    // Compute value T = 'first event beginning' - 'delay value of hours'
    const computedAlarmDate = new Date(firstEventStart.getTime() - (config.delayHours * 60 * 60 * 1000));
    const alarmHourStr = String(computedAlarmDate.getHours()).padStart(2, '0');
    const alarmMinStr = String(computedAlarmDate.getMinutes()).padStart(2, '0');
    const computedAlarmTime = `${alarmHourStr}:${alarmMinStr}`;

    // Add success log
    dbService.addLog({
      email: config.email,
      date: logDateStr,
      firstEventTitle: firstEvent.summary || 'No Title',
      firstEventStart: firstEventStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
      thresholdTime: config.thresholdTime,
      delayHours: config.delayHours,
      computedAlarm: computedAlarmTime,
      status: 'ALARM_SET'
    });

    res.json({
      has_alarm: true,
      alarm_time: computedAlarmTime,
      alarm_hour: computedAlarmDate.getHours(),
      alarm_minute: computedAlarmDate.getMinutes(),
      status: 'ALARM_SET',
      message: `Alarm calculated successfully for ${computedAlarmTime}.`,
      first_event_title: firstEvent.summary || 'No Title',
      first_event_start: firstEventStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
      delay_value: config.delayHours,
    });
  } catch (error: any) {
    console.error(`Companion alarm check failed:`, error);
    
    dbService.addLog({
      email: config.email,
      date: new Date().toISOString().split('T')[0],
      thresholdTime: config.thresholdTime,
      delayHours: config.delayHours,
      status: 'ERROR',
      errorMessage: error.message || String(error)
    });

    res.status(500).json({
      has_alarm: false,
      status: 'ERROR',
      error: error.message || String(error),
    });
  }
});

// Main UI page and hot-loading configuration
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Smart Alarm server active running at: http://localhost:${PORT}`);
    console.log(`Companion Sync Endpoint is live at: /api/alarm/next`);
  });
}

startServer();
