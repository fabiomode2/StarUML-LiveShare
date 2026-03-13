const { Server } = require("socket.io");
const http = require("http");
const util = require("./get_ip.js");

// POR HACER:
// acabar mouses: renderizar mouses, solo renderizar si esta en diagrama
// al abrir documento, que se envie al completo
// que el server reenvie a todos los clientes
// verificar cambios...

// socket.emit() solo al emisor
// socket.broadcast.emit(), a todos menos a mi mismo
// this.io.emit() a todos

class LiveShareServer {
  constructor() {
    this.io = null;
    this.server = null;
    this.address = "";
    this.users = {};
  }

  start(port = 3000) {
    this.server = http.createServer();
    this.io = new Server(this.server, {
      cors: { origin: "*" },
    });

    //user connected
    this.io.on("connection", (socket) => {
      console.log("User connected:", socket.id);

      const username = socket.handshake.auth.username || "Anónimo";
      this.users[socket.id] = { id: socket.id, name: username, color: "blue" };

      // diagram changes
      socket.on("sync-operation", (op) => {
        // broadcast.emit lo envía a todos MENOS al que lo mandó
        socket.broadcast.emit("remote-operation", op);
      });

      // mouse movement
      socket.on("cursor-move", (data) => {
        socket.broadcast.emit("remote-cursor", {
          id: socket.id,
          x: data.x,
          y: data.y,
        });
      });

      // user disconnected
      socket.on("disconnect", () => {
        console.log("user disconnected: " + socket.id);
        this.io.emit("user-left", socket.id);
        delete this.users[socket.id];
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

let socket = null; //cliente
let server = new LiveShareServer(); //server
const defaultPort = 6789;
const io = require("socket.io-client");
const fachada = require("./fachada.js");

function startServer(port) {
  const targetPort = port || 3000;
  console.log(`[LiveShare] Trying to start server on port ${targetPort}`);

  try {
    server.start(targetPort);

    setTimeout(() => {
      connectToServer(`http://${util.get_ip()}:${targetPort}`);
    }, 500);
  } catch (e) {
    console.error("[LiveShare] Error starting server:", e);
  }

  server.address = `http://${util.get_ip()}:${targetPort}`;
}

function connectToServer(url, name) {
  console.log("[LiveShare] Trying to connect to:", url);
  conectado = false;

  socket = io(url, {
    reconnectionAttempts: 3,
    timeout: 10000,
    auth: {
      username: name,
    },
  });

  socket.on("connect", () => {
    console.log("[LiveShare] ¡Socket connected with ID:", socket.id);
    fachada.INFO("Connected to session!");
    conectado = true;
  });

  socket.on("connect_error", (err) => {
    console.error("[LiveShare] Conexion error:", err);
    fachada.ERR("Conexion error: " + err.message);
    conectado = false;
  });

  app.repository.on("operationExecuted", (operation) => {
    if (socket && socket.connected) {
      // Si nosotros hicimos un cambio, lo enviamos al servidor
      // No enviamos si el cambio vino de la red (bypassConfirmation)
      socket.emit("sync-operation", operation);
    }
  });

  socket.on("remote-operation", (op) => {
    try {
      app.repository.bypassConfirmation = true;
      app.repository.doOperation(op);
    } catch (err) {
      console.error("Error aplying remote operation", err);
    }
  });

  server.address = url;
  return conectado;
}

function stopServer() {
  if (server) {
    server.stop();
    fachada.INFO("Session ended");
  }
}

function getSessionLink() {
  if (server) return server.address;
}

function getServer() {
  return server;
}

module.exports = {
  LiveShareServer: LiveShareServer,
  startServer: startServer,
  connectToServer: connectToServer,
  stopServer: stopServer,
  getSessionLink: getSessionLink,
  defaultPort: defaultPort,
  getServer: getServer,
};
