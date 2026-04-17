const { Server } = require("socket.io");
const http = require("http");
const { networkInterfaces } = require("os"); // for getting self ip

let server = null;
const defaultPort = 6789;

class LiveShareServer {
  constructor() {
    this.io = null;
    this.server = null;
    this.address = "";
    this.users = {};
    this.locks = {}; // { viewId: socketId }
    this.rooms = {}; //{users; {}, address: "", host_id: null}
  }

  start(port = 3000) {
    this.server = http.createServer();
    this.io = new Server(this.server, {
      cors: { origin: "*" },
      pingTimeout: 60000,
      pingInterval: 25000,
      maxHttpBufferSize: 1e8,
    });

    this.io.on("connection", async (socket) => {
      const username = socket.handshake.auth.username || "Anonymous"; //get name
      let room_id = socket.handshake.auth.room; // get room_id

      console.log(`[LS] User connected:${username}, ${socket.id}`);

      if (!room_id || room_id == -1 || room_id === "-1" || room_id === "null") {
        room_id = "room_" + Math.random().toString(36).substring(2, 10); //generate random room id
        console.log(`[LS] Room created :${room_id}`);
      }

      await socket.join(room_id);

      // if room does not exist, create it
      if (!this.rooms[room_id])
        this.rooms[room_id] = { users: {}, host_id: socket.id, locks: {} };

      const isHost = socket.id == this.rooms[room_id].host_id;
      this.rooms[room_id].users[socket.id] = socket.id;

      this.users[socket.id] = {
        id: socket.id,
        name: username,
        isHost: isHost,
        room: room_id,
        color: "#" + Math.floor(Math.random() * 16777215).toString(16), // color for locks
      };

      socket.emit("is-host", isHost);
      socket.emit("room-assigned", room_id);

      // Send current users in room to the newly joined client
      const roomUsers = this.rooms[room_id].users;
      const otherUsers = Object.keys(roomUsers)
        .filter((uid) => uid !== socket.id)
        .map((uid) => ({
          id: uid,
          name: this.users[uid] ? this.users[uid].name : "Anonymous",
        }));
      socket.emit("current-users", otherUsers);

      socket.to(room_id).emit("user-joined", { id: socket.id, name: username });

      if (!isHost && this.rooms[room_id].host_id) {
        this.io
          .to(this.rooms[room_id].host_id)
          .emit("get-whole-document", { requesterId: socket.id });
      }

      socket.on("host-delivers-document", (data) => {
        this.io.to(data.to).emit("load-whole-document", { json: data.json });
      });

      socket.on("client-mouse-moved", (data) => {
        socket.to(this.users[socket.id].room).emit("update-mouse-pos", {
          id: socket.id,
          x: data.x,
          y: data.y,
          diagram: data.diagram,
          zoom: data.zoom,
          originX: data.originX,
          originY: data.originY,
          name: this.users[socket.id].name,
        });
      });

      socket.on("request-follow-sync", (data) => {
        if (data.targetId && this.users[data.targetId]) {
          this.io.to(data.targetId).emit("get-follow-sync", {
            requesterId: socket.id
          });
        }
      });

      socket.on("response-follow-sync", (data) => {
        if (data.requesterId && this.users[data.requesterId]) {
          this.io.to(data.requesterId).emit("follower-sync-data", {
            id: socket.id,
            ...data.viewportData
          });
        }
      });

      socket.on("request-doc", () => {
        console.log(
          `[LS] ${this.users[socket.id].name} requested the whole doc.`,
        );

        this.io
          .to(this.rooms[this.users[socket.id].room].host_id)
          .emit("get-whole-document", { requesterId: socket.id });
      });

      socket.on("sync-operation", (op) => {
        const userData = this.users[socket.id];

        if (userData && userData.room) {
          console.log(
            `[LS] ${userData.name} sent operation to room ${userData.room}`,
          );
          socket.to(userData.room).emit("remote-operation", op);
        }
      });

      socket.on("sync-undo", () => {
        const userData = this.users[socket.id];
        if (userData && userData.room) {
          socket.to(userData.room).emit("remote-undo");
        }
      });

      socket.on("sync-redo", () => {
        const userData = this.users[socket.id];
        if (userData && userData.room) {
          socket.to(userData.room).emit("remote-redo");
        }
      });

      socket.on("lock-element", (viewIds) => {
        const room_id = this.users[socket.id].room;

        viewIds.forEach((id) => {
          if (!this.rooms[room_id].locks[id]) {
            this.rooms[room_id].locks[id] = socket.id;
            this.io.to(this.users[socket.id].room).emit("element-locked", {
              viewId: id,
              ownerId: socket.id,
              color: this.users[socket.id].color,
            });
          }
        });
      });

      socket.on("unlock-elements", () => {
        const room_id = this.users[socket.id].room;

        for (let id in this.rooms[room_id].locks) {
          if (this.rooms[room_id].locks[id] === socket.id) {
            delete this.rooms[room_id].locks[id];
            this.io
              .to(this.users[socket.id].room)
              .emit("element-unlocked", { viewId: id });
          }
        }
      });

      socket.on("disconnect", () => {
        const userData = this.users[socket.id];

        if (!userData) return;

        const room_id = userData.room;

        // remove locks
        for (let id in this.rooms[room_id].locks) {
          if (this.rooms[room_id].locks[id] === socket.id) {
            delete this.rooms[room_id].locks[id];
            this.io.to(room_id).emit("element-unlocked", { viewId: id });
          }
        }

        // notify
        console.log(`[LS] ${this.users[socket.id].name}, ${socket.id} left.`);
        this.io.to(room_id).emit("user-left", socket.id);

        // room logic
        if (this.rooms[room_id]) {
          delete this.rooms[room_id].users[socket.id];
          let remainingUsers = Object.keys(this.rooms[room_id].users);

          if (this.rooms[room_id].host_id === socket.id) {
            this.io.to(room_id).emit("host-left", { oldHostId: socket.id });

            if (remainingUsers.length > 0) {
              let new_host = remainingUsers[0];
              this.rooms[room_id].host_id = new_host;
              this.io.to(new_host).emit("is-host", true);

              if (this.users[new_host]) this.users[new_host].isHost = true;
            }
          }

          if (remainingUsers.length === 0) {
            delete this.rooms[room_id];
          }
        }

        // delete user
        delete this.users[socket.id];
      });
    });

    this.server.listen(port, () => {
      console.log(`[LS] LiveShare server running on port ${port}`);
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

function startServer(port) {
  if (server) server.stop();
  server = new LiveShareServer();
  const targetPort = port || 3000;

  try {
    server.start(targetPort);
    server.server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.error(`Port ${targetPort} occupied. Close other instances.`);
      }
    });
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

function get_ip() {
  const nets = networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.internal) continue;

      const isIPv4 = net.family === "IPv4" || net.family === 4;

      if (isIPv4) {
        return net.address;
      }
    }
  }
  return "127.0.0.1"; // fallback
}

module.exports = {
  LiveShareServer,
  startServer,
  stopServer,
  getServerAddress,
  getServer,
  defaultPort,
};
