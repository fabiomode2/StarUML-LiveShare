const { Server } = require("socket.io");
const http = require("http");
const util = require("./get_ip.js");

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
      pingTimeout: 30000,
      pingInterval: 10000,
      maxHttpBufferSize: 1e8,
    });

    this.io.on("connection", (socket) => {
      console.log("User connected:", socket.id);

      const username = socket.handshake.auth.username || "Anonymous";
      let room_id = socket.handshake.auth.room;

      if (room_id == -1 || !room_id) room_id = socket.id;
      socket.join(room_id);

      if (!this.rooms[room_id])
        this.rooms[room_id] = { users: {}, host_id: socket.id };

      const isHost = socket.id == this.rooms[room_id].host_id;
      this.rooms[room_id].users[socket.id] = socket.id;

      this.users[socket.id] = {
        id: socket.id,
        name: username,
        isHost: isHost,
        room: room_id,
        color: "#" + Math.floor(Math.random() * 16777215).toString(16), // Color aleatorio para locks
      };

      socket.emit("is-host", isHost);
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
          name: this.users[socket.id].name,
        });
      });

      socket.on("request-doc", () => {
        this.io
          .to(this.rooms[this.users[socket.id].room].host_id)
          .emit("get-whole-document", { requesterId: socket.id });
      });

      socket.on("sync-operation", (op) => {
        socket.to(this.users[socket.id].room).emit("remote-operation", op);
      });

      socket.on("sync-undo", () => {
        socket.to(this.users[socket.id].room).emit("remote-undo");
      });

      socket.on("sync-redo", () => {
        socket.to(this.users[socket.id].room).emit("remote-redo");
      });

      socket.on("lock-element", (viewIds) => {
        viewIds.forEach((id) => {
          if (!this.locks[id]) {
            this.locks[id] = socket.id;
            this.io.to(this.users[socket.id].room).emit("element-locked", {
              viewId: id,
              ownerId: socket.id,
              color: this.users[socket.id].color,
            });
          }
        });
      });

      socket.on("unlock-elements", () => {
        for (let id in this.locks) {
          if (this.locks[id] === socket.id) {
            delete this.locks[id];
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

        // 1. Liberar candados (usando la variable local room_id)
        for (let id in this.locks) {
          if (this.locks[id] === socket.id) {
            delete this.locks[id];
            this.io.to(room_id).emit("element-unlocked", { viewId: id });
          }
        }

        // 2. Notificar salida
        this.io.to(room_id).emit("user-left", socket.id);

        // 3. Manejar lógica de sala
        if (this.rooms[room_id]) {
          delete this.rooms[room_id].users[socket.id];
          let remainingUsers = Object.keys(this.rooms[room_id].users);

          if (
            this.rooms[room_id].host_id === socket.id &&
            remainingUsers.length > 0
          ) {
            let new_host = remainingUsers[0];
            this.rooms[room_id].host_id = new_host;
            this.io.to(new_host).emit("is-host", true);
            // Actualizar el flag en this.users del nuevo host
            if (this.users[new_host]) this.users[new_host].isHost = true;
          }

          if (remainingUsers.length === 0) {
            delete this.rooms[room_id];
          }
        }

        // 4. BORRAR AL FINAL
        delete this.users[socket.id];
      });
    });

    this.server.listen(port, () => {
      console.log(`Servidor LiveShare running on port ${port}`);
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
        app.toast.error(`Port ${targetPort} occupied. Close other instances.`);
      }
    });
  } catch (e) {
    return false;
  }
  server.address = `http://${util.get_ip()}:${targetPort}`;
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

module.exports = {
  LiveShareServer,
  startServer,
  stopServer,
  getServerAddress,
  getServer,
  defaultPort,
};
