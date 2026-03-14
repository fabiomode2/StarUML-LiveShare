const { Server } = require("socket.io");
const http = require("http");
const util = require("./get_ip.js");

// socket.emit() solo al emisor
// socket.broadcast.emit(), a todos menos a mi mismo
// this.io.emit() a todos

let server = null; //server
const defaultPort = 6789;

class LiveShareServer {
  constructor() {
    this.io = null;
    this.server = null;
    this.address = "";
    this.users = {};
    this.host_id = null;
    this.locks = {}; // { viewId: socketId }
  }

  start(port = 3000) {
    this.server = http.createServer();
    this.io = new Server(this.server, {
      cors: { origin: "*" },
      pingTimeout: 30000, // 30 segundos (antes de desconectar)
      pingInterval: 10000, // Enviar ping cada 10 seg
      maxHttpBufferSize: 1e8, // 100MB por si el JSON crece mucho
    });

    //user connected
    this.io.on("connection", (socket) => {
      console.log("User connected:", socket.id);

      const isHost = Object.keys(this.users).length === 0;
      const username = socket.handshake.auth.username || "Anonymous";
      this.users[socket.id] = { id: socket.id, name: username, isHost: isHost };
      if (isHost) this.host_id = socket.id;

      socket.emit("is-host", isHost);
      socket.broadcast.emit("user-joined", { id: socket.id, name: username });

      // ask HOST for whole document to send to new user
      if (!isHost && this.host_id) {
        this.io
          .to(this.host_id)
          .emit("get-whole-document", { requesterId: socket.id });
      }

      // recieve whole document from HOST and send it to new user
      socket.on("host-delivers-document", (data) => {
        this.io.to(data.to).emit("load-whole-document", { json: data.json });
      });

      // diagram changes
      socket.on("sync-operation", (op) => {
        // broadcast.emit lo envía a todos MENOS al que lo mandó
        socket.broadcast.emit("remote-operation", op);
      });

      // mouse movement
      socket.on("client-mouse-moved", (data) => {
        socket.broadcast.emit("update-mouse-pos", {
          id: socket.id,
          x: data.x,
          y: data.y,
          diagram: data.diagram,
          name: this.users[socket.id].name,
        });
      });

      socket.on("sync-undo", () => {
        socket.broadcast.emit("remote-undo");
      });
      socket.on("sync-redo", () => {
        socket.broadcast.emit("remote-redo");
      });

      // // lock element
      // socket.on("lock-element", (viewIds) => {
      //   viewIds.forEach((id) => {
      //     if (!this.locks[id]) {
      //       this.locks[id] = socket.id;
      //       this.io.emit("element-locked", { viewId: id, ownerId: socket.id });
      //     }
      //   });
      // });

      // // unlock element
      // socket.on("unlock-elements", () => {
      //   for (let id in this.locks) {
      //     if (this.locks[id] === socket.id) {
      //       delete this.locks[id];
      //       this.io.emit("element-unlocked", { viewId: id });
      //     }
      //   }
      // });

      // user disconnected
      socket.on("disconnect", () => {
        console.log("user disconnected: " + socket.id);
        this.io.emit("user-left", socket.id);
        delete this.users[socket.id];
      });

      // user sends opearations
      socket.on("sync-operation", (op) => {
        socket.broadcast.emit("remote-operation", op);
      });
    });

    this.server.listen(port, () => {
      console.log(`Servidor LiveShare running on port ${port}`);
    });
  }

  // stop the server
  stop() {
    if (this.server) this.server.close();
  }
}

function startServer(port) {
  if (server) {
    server.stop();
  }

  server = new LiveShareServer();
  const targetPort = port || 3000;
  console.log(`[LiveShare] Trying to start server on port ${targetPort}`);

  try {
    server.start(targetPort);

    server.server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.error(`[LiveShare] Port ${targetPort} already occupied.`);
        app.toast.error(`Port ${targetPort} occupied. Close other instances.`);
      }
    });
  } catch (e) {
    console.error("[LiveShare] Error starting server:", e);
    return false;
  }

  server.address = `http://${util.get_ip()}:${targetPort}`;
  console.log("Started server on " + server.address);
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
  LiveShareServer: LiveShareServer,
  startServer: startServer,
  stopServer: stopServer,
  getServerAddress: getServerAddress,
  getServer: getServer,
  defaultPort: defaultPort,
};
