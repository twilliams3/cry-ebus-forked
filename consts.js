module.exports = {
    WORKER: 'EBW01',
    CLIENT: 'EBC01',
    BROKER: "EBB01",
  
    READY: 'READY',
    REQUEST: 'REQ',
    REPLY: 'REPLY',
    CANCEL: 'CANCEL',
    PING: 'PING',
    HEARTBEAT: 'HEARTBEAT',
    DISCONNECT: 'DISCONNECT',
    REJECT: 'REJECT',
    EXPIRED: 'EXPIRED',
    SERVICES: 'SERVICES',
    WORKERS: 'WORKERS',
  
    HEARTBEATMS: 500,
    RESENDRQX: 3, // resend request x times request expiery
    RESENDRQMS: 1 * 1000, // resend request after so long
    EXPIRERQMS: 3 * 1000, // expire (kill) request after ms
    CACHERQX: 3, // cache requests for so long (ms)
    CACHERQMS: 5 * 1000, // cache requests for so long (ms)
    HEARTBEAT_LIVENESS_FOR_BROKER: 5, // max number of missed heartbeats before broker is declared offline by worker
    HEARTBEAT_LIVENESS_FOR_WORKER: 5, // max number of missed heartbeats before worker is declared offline by broker
  
    MAXWORKERLOAD: 5, // max requests send to worker
    // MAXMESSAGESSTORED: 10000, // max number of messages stored in memory
  
    FRONTEND: 5000,
    BACKEND: 5001,
    PUB: 5002,
    SUB: 5003,
  
    PUBHWM: 1000,
  
    PUB_EBUS_STARTED: 'ebus/started',
    PUB_EBUS_SHUTDOWN: 'ebus/shutdown',
    PUB_WORKERS_CHANNEL: 'ebus/workers'
  };