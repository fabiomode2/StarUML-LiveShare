const { Server } = require('socket.io');
const http = require('http');
const { randomBytes } = require('crypto');
const { networkInterfaces } = require('os');

let server = null;
const defaultPort = 6789;
const MAX_OP_HISTORY = 500;
const EVICTION_HANDOVER_TIMEOUT = 15000;

class LiveShareServer {
  constructor() {
    this.io = null;
    this.server = null;
    this.address = '';
    this.users = {};
    this.locks = {};
    this.rooms = {};
    this.roomSeqs = {};
    this.opHistory = {};
    this.pendingEvictions = {};
  }

  start(port = 3000) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer();
      this.io = new Server(this.server, {
        cors: { origin: '*' },
        pingTimeout: 60000,
        pingInterval: 25000,
        maxHttpBufferSize: 1e8,
      });

      this.io.on('connection', async (socket) => {
        const username = socket.handshake.auth.username || 'Anonymous';
        let room_id = socket.handshake.auth.room;

        console.log(`[LS] User connected: ${username}, ${socket.id}`);

        if (
          !room_id ||
          room_id == -1 ||
          room_id === '-1' ||
          room_id === 'null'
        ) {
          room_id = 'room_' + randomBytes(16).toString('hex');
          console.log(`[LS] Room created: ${room_id}`);
        }

        await socket.join(room_id);

        if (!this.rooms[room_id]) {
          this.rooms[room_id] = { users: {}, host_id: socket.id, locks: {} };
        }
        if (!this.roomSeqs[room_id]) this.roomSeqs[room_id] = 0;
        if (!this.opHistory[room_id]) this.opHistory[room_id] = [];

        let handoverPending = false;
        for (const [sid] of Object.entries(this.rooms[room_id].users)) {
          if (
            sid !== socket.id &&
            this.users[sid] &&
            this.users[sid].name === username
          ) {
            delete this.rooms[room_id].users[sid];
            delete this.users[sid];
            for (let id in this.rooms[room_id].locks) {
              if (this.rooms[room_id].locks[id] === sid) {
                delete this.rooms[room_id].locks[id];
                this.io.to(room_id).emit('element-unlocked', { viewId: id });
              }
            }
            socket.to(room_id).emit('user-left', sid);
            let deferDisconnect = false;
            if (this.rooms[room_id].host_id === sid) {
              this.io.to(room_id).emit('host-left', { oldHostId: sid });
              const remaining = Object.keys(this.rooms[room_id].users);
              if (remaining.length > 0) {
                // A peer takes over, but the evicted host may still hold the
                // most recent document. Ask it for a handover before closing
                // its socket; the joiners wait for the handover so nobody
                // loads the pre-handover snapshot.
                this.promoteHost(room_id, remaining[0], {
                  evictionHandover: true,
                });
                this.requestEvictionHandover(
                  room_id,
                  sid,
                  remaining[0],
                  socket.id,
                );
              } else {
                this.rooms[room_id].host_id = socket.id;
                this.requestEvictionHandover(
                  room_id,
                  sid,
                  socket.id,
                  socket.id,
                );
              }
              deferDisconnect = true;
              handoverPending = true;
            }
            if (!deferDisconnect) {
              const evictedSocket = this.io.sockets.sockets.get(sid);
              if (evictedSocket) evictedSocket.disconnect(true);
            }
          }
        }

        const isHost = socket.id === this.rooms[room_id].host_id;
        this.rooms[room_id].users[socket.id] = socket.id;

        this.users[socket.id] = {
          id: socket.id,
          name: username,
          isHost: isHost,
          room: room_id,
          docReady: false,
          color: '#' + Math.floor(Math.random() * 16777215).toString(16),
        };

        socket.emit('is-host', isHost);
        socket.emit('room-assigned', room_id);
        socket.emit('sync-capabilities', { syncAck: true });
        socket.emit('room-seq', this.roomSeqs[room_id]);

        const roomUsers = this.rooms[room_id].users;
        const otherUsers = Object.keys(roomUsers)
          .filter((uid) => uid !== socket.id)
          .map((uid) => ({
            id: uid,
            name: this.users[uid] ? this.users[uid].name : 'Anonymous',
          }));
        if (!handoverPending) {
          socket.emit('current-users', otherUsers);
        }

        socket
          .to(room_id)
          .emit('user-joined', { id: socket.id, name: username });

        if (!isHost && !handoverPending && this.rooms[room_id].host_id) {
          this.io
            .to(this.rooms[room_id].host_id)
            .emit('get-whole-document', { requesterId: socket.id });
        }

        socket.on('doc-ready', () => {
          const userData = this.users[socket.id];
          if (userData) userData.docReady = true;
        });

        socket.on('latency-check', () => {
          socket.emit('latency-response');
        });

        socket.on('host-delivers-document', (data) => {
          if (this.users[data.to]) this.users[data.to].docReady = false;
          if (data.seq === undefined) {
            this.io.to(data.to).emit('load-whole-document', {
              json: data.json,
            });
          } else {
            this.io.to(data.to).emit('load-whole-document', {
              json: data.json,
              seq: data.seq,
              forEviction: data.forEviction === true,
            });
          }
          if (data.forEviction === true && this.pendingEvictions[socket.id]) {
            this.resolveEviction(socket.id);
          }
        });

        socket.on('client-mouse-moved', (data) => {
          const userData = this.users[socket.id];
          if (!userData || !userData.room) return;
          socket.to(userData.room).emit('update-mouse-pos', {
            id: socket.id,
            x: data.x,
            y: data.y,
            diagram: data.diagram,
            zoom: data.zoom,
            originX: data.originX,
            originY: data.originY,
            name: userData.name,
          });
        });

        socket.on('request-follow-sync', (data) => {
          if (data.targetId && this.users[data.targetId]) {
            this.io.to(data.targetId).emit('get-follow-sync', {
              requesterId: socket.id,
            });
          }
        });

        socket.on('response-follow-sync', (data) => {
          if (data.requesterId && this.users[data.requesterId]) {
            this.io.to(data.requesterId).emit('follower-sync-data', {
              id: socket.id,
              ...data.viewportData,
            });
          }
        });

        socket.on('request-doc', () => {
          const userData = this.users[socket.id];
          if (!userData || !this.rooms[userData.room]) return;
          userData.docReady = false;
          console.log(`[LS] ${userData.name} requested the whole doc.`);
          this.io
            .to(this.rooms[userData.room].host_id)
            .emit('get-whole-document', { requesterId: socket.id });
        });

        socket.on('sync-operation', (opStr) => {
          const userData = this.users[socket.id];
          if (!userData || !userData.room) return;
          const room_id = userData.room;

          if (!this.opHistory[room_id]) this.opHistory[room_id] = [];
          if (!this.roomSeqs[room_id]) this.roomSeqs[room_id] = 0;

          this.roomSeqs[room_id]++;
          const seq = this.roomSeqs[room_id];

          this.opHistory[room_id].push({
            seq,
            socketId: socket.id,
            operation: opStr,
            timestamp: Date.now(),
          });
          if (this.opHistory[room_id].length > MAX_OP_HISTORY) {
            this.opHistory[room_id].shift();
          }

          this.io.to(room_id).emit('remote-operation', {
            seq,
            operation: opStr,
            socketId: socket.id,
          });
          socket.emit('sync-ack', { seq });
          this.io.to(room_id).emit('room-seq', seq);
        });

        socket.on('request-missed-ops', (data) => {
          const userData = this.users[socket.id];
          if (!userData) return;
          const room_id = userData.room;
          const fromSeq = data.fromSeq;
          const history = this.opHistory[room_id] || [];

          const missed = history.filter((entry) => entry.seq > fromSeq);

          if (missed.length > 0) {
            console.log(
              `[LS] Sending ${missed.length} missed ops to ${userData.name} (from seq ${fromSeq})`,
            );
          }
          socket.emit('missed-ops', { ops: missed });
        });

        socket.on('lock-element', (viewIds) => {
          const userData = this.users[socket.id];
          if (!userData || !userData.room) return;
          const room_id = userData.room;
          if (!this.rooms[room_id]) return;

          viewIds.forEach((id) => {
            if (this.rooms[room_id].locks[id]) return;
            this.rooms[room_id].locks[id] = socket.id;
            this.io.to(room_id).emit('element-locked', {
              viewId: id,
              ownerId: socket.id,
              color: userData.color,
            });
          });
        });

        socket.on('unlock-elements', () => {
          const userData = this.users[socket.id];
          if (!userData || !userData.room) return;
          const room_id = userData.room;
          if (!this.rooms[room_id]) return;

          for (let id in this.rooms[room_id].locks) {
            if (this.rooms[room_id].locks[id] === socket.id) {
              delete this.rooms[room_id].locks[id];
              this.io.to(room_id).emit('element-unlocked', { viewId: id });
            }
          }
        });

        socket.on('disconnect', () => {
          if (this.pendingEvictions[socket.id]) {
            this.resolveEviction(socket.id);
            return;
          }

          const userData = this.users[socket.id];
          if (!userData) return;

          const room_id = userData.room;

          if (this.rooms[room_id]) {
            for (let id in this.rooms[room_id].locks) {
              if (this.rooms[room_id].locks[id] === socket.id) {
                delete this.rooms[room_id].locks[id];
                this.io.to(room_id).emit('element-unlocked', { viewId: id });
              }
            }

            console.log(`[LS] ${userData.name}, ${socket.id} left.`);
            socket.to(room_id).emit('user-left', socket.id);
            delete this.rooms[room_id].users[socket.id];
            let remainingUsers = Object.keys(this.rooms[room_id].users);

            if (this.rooms[room_id].host_id === socket.id) {
              this.io.to(room_id).emit('host-left', { oldHostId: socket.id });

              if (remainingUsers.length > 0) {
                this.promoteHost(room_id, remainingUsers[0]);
              }
            }

            if (remainingUsers.length === 0) {
              delete this.rooms[room_id];
              delete this.roomSeqs[room_id];
              delete this.opHistory[room_id];
            }
          }

          delete this.users[socket.id];
        });
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[LS] Port ${port} occupied. Close other instances.`);
        }
        reject(err);
      });

      this.server.listen(port, () => {
        console.log(`[LS] LiveShare server running on port ${port}`);
        resolve();
      });
    });
  }

  requestEvictionHandover(room_id, evictedSid, receiverId, joinerId) {
    const timer = setTimeout(() => {
      console.log('[LS] Eviction handover timed out');
      this.resolveEviction(evictedSid);
    }, EVICTION_HANDOVER_TIMEOUT);
    this.pendingEvictions[evictedSid] = {
      timer,
      receiverId,
      joinerId,
      roomId: room_id,
    };
    this.io.to(evictedSid).emit('get-whole-document', {
      requesterId: receiverId,
      forEviction: true,
    });
  }

  resolveEviction(evictedSid) {
    const pending = this.pendingEvictions[evictedSid];
    if (!pending) return;
    clearTimeout(pending.timer);
    delete this.pendingEvictions[evictedSid];

    const evictedSocket = this.io.sockets.sockets.get(evictedSid);
    if (evictedSocket && evictedSocket.connected) {
      evictedSocket.disconnect(true);
    }

    const room = this.rooms[pending.roomId];
    if (!room) return;

    const userListFor = (uid) =>
      Object.keys(room.users)
        .filter((id) => id !== uid)
        .map((id) => ({
          id,
          name: this.users[id] ? this.users[id].name : 'Anonymous',
        }));

    const receiver = this.io.sockets.sockets.get(pending.receiverId);
    if (receiver) {
      receiver.emit('current-users', userListFor(pending.receiverId));
    }

    const joiner = this.io.sockets.sockets.get(pending.joinerId);
    if (joiner && joiner !== receiver) {
      joiner.emit('current-users', userListFor(pending.joinerId));
      if (receiver) {
        // The receiver has already processed the handover document (this runs
        // right after the relay, on the same socket), so this second request
        // delivers the merged document to the joiner as well.
        this.io.to(pending.receiverId).emit('get-whole-document', {
          requesterId: pending.joinerId,
        });
      }
    }
  }

  promoteHost(room_id, new_host, options = {}) {
    this.rooms[room_id].host_id = new_host;
    this.users[new_host].isHost = true;

    const roomUsers = this.rooms[room_id].users;
    const otherUsers = Object.keys(roomUsers).filter((uid) => uid !== new_host);
    if (!options.evictionHandover && otherUsers.length > 0) {
      const readyPeers = otherUsers.filter(
        (uid) => this.users[uid] && this.users[uid].docReady,
      );
      const newHostReady =
        this.users[new_host] && this.users[new_host].docReady;
      // A ready host already has a valid document. If no peer is ready,
      // prefer keeping it over pulling a possibly unrelated document from a
      // peer that is still loading. Legacy peers never report ready, so the
      // old fallback still applies for mixed-version rooms.
      if (readyPeers.length > 0 || !newHostReady) {
        const candidates = readyPeers.length > 0 ? readyPeers : otherUsers;
        const history = this.opHistory[room_id] || [];
        let bestPeer = candidates[0];
        let bestTs = -1;
        for (const uid of candidates) {
          let ts = -1;
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].socketId === uid) {
              ts = history[i].timestamp;
              break;
            }
          }
          if (ts > bestTs) {
            bestTs = ts;
            bestPeer = uid;
          }
        }
        this.io
          .to(bestPeer)
          .emit('get-whole-document', { requesterId: new_host });
      }
    }

    this.io.to(new_host).emit('is-host', true);
    if (!options.evictionHandover) {
      const allUsers = Object.keys(roomUsers)
        .filter((uid) => uid !== new_host)
        .map((uid) => ({
          id: uid,
          name: this.users[uid] ? this.users[uid].name : 'Anonymous',
        }));
      this.io.to(new_host).emit('current-users', allUsers);
    }
    this.io.to(room_id).except(new_host).emit('new-host', new_host);
  }

  stop() {
    for (const sid in this.pendingEvictions) {
      clearTimeout(this.pendingEvictions[sid].timer);
    }
    this.pendingEvictions = {};
    if (this.server) this.server.close();
  }
}

async function startServer(port) {
  if (server) server.stop();
  server = new LiveShareServer();
  const targetPort = port || 3000;

  try {
    await server.start(targetPort);
  } catch (e) {
    return false;
  }
  server.address = `http://${get_ip()}:${targetPort}`;
  return true;
}

function stopServer() {
  if (server) server.stop();
}

function getServerAddress() {
  if (server) return server.address;
}

function getServer() {
  return server;
}

function getServerPort() {
  return server && server.server && server.server.address()
    ? server.server.address().port
    : defaultPort;
}

function get_ip() {
  const nets = networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(nets)) {
    const nameLower = name.toLowerCase();

    if (
      nameLower.includes('docker') ||
      nameLower.includes('wsl') ||
      nameLower.includes('virtualbox') ||
      nameLower.includes('vbox') ||
      nameLower.includes('vmware') ||
      nameLower.includes('wg') ||
      nameLower.includes('ppp') ||
      nameLower.includes('vpn') ||
      nameLower.includes('tailscale') ||
      nameLower.includes('tun') ||
      nameLower.includes('tap') ||
      nameLower.includes('bridge') ||
      nameLower.startsWith('br-') ||
      nameLower.includes('loopback')
    ) {
      continue;
    }

    for (const net of nets[name]) {
      if (net.internal) continue;
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (isIPv4) {
        let priority = 3;
        if (net.address.startsWith('192.168.')) {
          priority = 0;
        } else {
          const parts = net.address.split('.');
          if (parts[0] === '172') {
            const second = parseInt(parts[1], 10);
            if (second >= 16 && second <= 31) priority = 1;
          }
        }
        if (net.address.startsWith('10.')) priority = 2;
        candidates.push({ address: net.address, priority });
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
}

module.exports = {
  LiveShareServer,
  startServer,
  stopServer,
  getServerAddress,
  getServer,
  getServerPort,
  defaultPort,
};
