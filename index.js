const WebSocket = require('ws');
const si = require('systeminformation');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:3000';
const SERVER_ID = process.env.SERVER_ID || '1';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'secure-vps-token-12345';

let ws;
let terminalProcess = null;
let reconnectInterval = 5000;

function connect() {
  const url = `${GATEWAY_URL}?role=agent&server_id=${SERVER_ID}&token=${AUTH_TOKEN}`;
  console.log(`Connecting to Gateway: ${GATEWAY_URL} (Server ID: ${SERVER_ID})...`);
  
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('Connected to WebSocket Gateway!');
    startHeartbeat();
  });

  ws.on('message', (message) => {
    try {
      const payload = JSON.parse(message);
      handleMessage(payload);
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });

  ws.on('close', () => {
    console.log('Gateway connection closed. Reconnecting...');
    stopHeartbeat();
    cleanupTerminal();
    setTimeout(connect, reconnectInterval);
  });

  ws.on('error', (err) => {
    console.error('WebSocket connection error:', err.message);
  });
}

// ----------------------------------------------------
// HEARTBEAT & SYSTEM METRICS
// ----------------------------------------------------
let heartbeatTimer = null;

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      // Fetch CPU load, memory usage, disk, uptime
      const cpuLoad = await si.currentLoad();
      const mem = await si.mem();
      const disk = await si.fsSize();
      const time = si.time();

      const mainDisk = disk[0] || { use: 0 };
      
      const metrics = {
        cpu: Math.round(cpuLoad.currentLoad),
        ram: Math.round((mem.active / mem.total) * 100),
        disk: Math.round(mainDisk.use),
        uptime: Math.round(time.uptime)
      };

      ws.send(JSON.stringify({
        type: 'metrics',
        data: metrics
      }));
    } catch (err) {
      console.error('Failed to collect system metrics:', err);
    }
  }, 3000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ----------------------------------------------------
// TERMINAL MANAGER (PTY Simulation)
// ----------------------------------------------------
function startTerminal() {
  cleanupTerminal();

  console.log('Starting terminal session...');
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  
  terminalProcess = spawn(shell, [], {
    env: process.env,
    cwd: process.cwd()
  });

  terminalProcess.stdout.on('data', (data) => {
    sendToGateway({
      type: 'terminal_output',
      data: data.toString()
    });
  });

  terminalProcess.stderr.on('data', (data) => {
    sendToGateway({
      type: 'terminal_output',
      data: data.toString()
    });
  });

  terminalProcess.on('close', () => {
    console.log('Terminal process ended.');
    terminalProcess = null;
  });
}

function writeTerminal(data) {
  if (terminalProcess && terminalProcess.stdin.writable) {
    terminalProcess.stdin.write(data);
  }
}

function cleanupTerminal() {
  if (terminalProcess) {
    try {
      terminalProcess.kill();
    } catch (e) {}
    terminalProcess = null;
  }
}

// ----------------------------------------------------
// DOCKER INTEGRATION
// ----------------------------------------------------
function getDockerList() {
  exec('docker ps -a --format "{{json .}}"', (err, stdout, stderr) => {
    if (err) {
      sendToGateway({
        type: 'docker_list_res',
        data: { error: 'Docker daemon is not running or accessible.' }
      });
      return;
    }

    const lines = stdout.trim().split('\n').filter(Boolean);
    const containers = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    sendToGateway({
      type: 'docker_list_res',
      data: containers
    });
  });
}

function restartDockerContainer(containerId) {
  exec(`docker restart ${containerId}`, (err, stdout, stderr) => {
    if (err) {
      console.error(`Failed to restart container ${containerId}:`, stderr);
    }
    // Refresh list
    getDockerList();
  });
}

function getDockerLogs(containerId) {
  exec(`docker logs --tail 100 ${containerId}`, (err, stdout, stderr) => {
    const logs = err ? stderr : stdout;
    sendToGateway({
      type: 'docker_logs_res',
      data: { container_id: containerId, logs }
    });
  });
}

// ----------------------------------------------------
// COMMAND RUNNER (Automated Deployments)
// ----------------------------------------------------
function executeDeployment(deployId, commandStr) {
  console.log(`Starting deployment ${deployId}: "${commandStr}"`);
  
  // We can execute inside a project sandbox folder
  const deployDir = path.join(__dirname, 'sandbox');
  if (!fs.existsSync(deployDir)) {
    fs.mkdirSync(deployDir, { recursive: true });
  }

  // Choose appropriate command processor
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['-Command', commandStr] : ['-c', commandStr];

  const child = spawn(shell, args, {
    cwd: deployDir,
    env: { ...process.env, FORCE_COLOR: '1' }
  });

  let fullLog = '';

  child.stdout.on('data', (data) => {
    const chunk = data.toString();
    fullLog += chunk;
    sendToGateway({
      type: 'deploy_log',
      deployment_id: deployId,
      data: chunk
    });
  });

  child.stderr.on('data', (data) => {
    const chunk = data.toString();
    fullLog += chunk;
    sendToGateway({
      type: 'deploy_log',
      deployment_id: deployId,
      data: chunk
    });
  });

  child.on('close', (code) => {
    const status = code === 0 ? 'success' : 'failed';
    console.log(`Deployment ${deployId} completed with status: ${status}`);
    
    sendToGateway({
      type: 'deploy_finished',
      deployment_id: deployId,
      status: status,
      log: fullLog
    });
  });
}

// ----------------------------------------------------
// MAIN MESSAGE PARSER
// ----------------------------------------------------
function handleMessage(payload) {
  switch (payload.type) {
    case 'terminal_start':
      startTerminal();
      break;
    case 'terminal_input':
      writeTerminal(payload.data);
      break;
    case 'terminal_stop':
      cleanupTerminal();
      break;
    case 'docker_list':
      getDockerList();
      break;
    case 'docker_restart':
      restartDockerContainer(payload.container_id);
      break;
    case 'docker_logs':
      getDockerLogs(payload.container_id);
      break;
    case 'deploy':
      executeDeployment(payload.deployment_id, payload.command);
      break;
    default:
      console.log('Unknown action received from gateway:', payload.type);
  }
}

function sendToGateway(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

connect();
