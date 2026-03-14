const io = require("socket.io-client");
const mm_view = require("./mouses_view.js");
const mm_net = require("./mouses_net.js");
const fachada = require("./fachada.js");
const flatted = require("flatted");

let socket = null; //cliente
let address = "";
let users = {};
let am_i_host = false;
let isRemoteChange = false;

async function connectToServer(url, name) {
  return new Promise((resolve, reject) => {
    console.log("[LiveShare] Trying to connect to:", url);

    socket = io(url, {
      transports: ["websocket"],
      reconnectionAttempts: 3,
      timeout: 5000,
      auth: { username: name },
    });

    socket.on("user-joined", (data) => {
      if (!users[data.id]) users[data.id] = data.name;
      fachada.INFO(`${data.name} joined`);
    });

    socket.on("is-host", (is_host) => {
      am_i_host = is_host;
      if (!am_i_host) fachada.disableHostOptions();
      if (am_i_host) fachada.hideLoadingOverlay();
    });

    // render other clients mouses
    socket.on("update-mouse-pos", (data) => {
      if (data.id == socket.id) return;
      mm_view.updateMousePosition(data);
    });

    socket.on("get-whole-document", (data) => {
      console.log("[LiveShare] Someone joined, sending project...");
      try {
        const projectObj = app.project.getProject();
        const cleanObject = app.repository.writeObject(projectObj);
        const str = flatted.stringify(cleanObject);

        socket.emit("host-delivers-document", {
          to: data.requesterId,
          json: str,
        });

        console.log("[LiveShare] Proyect sent.");
      } catch (err) {
        console.error("[LiveShare] Error serializando proyecto:", err);
        app.toast.error("Error al enviar el proyecto al invitado.");
      }
    });

    socket.on("load-whole-document", (data) => {
      try {
        const projectObj = flatted.parse(data.json);
        app.repository.bypassConfirmation = true;
        //app.project.closeProject();

        app.project.loadFromJson(projectObj);

        app.repository.bypassConfirmation = false;
      } catch (err) {
        console.error("Error loading remote project:", err);
      }
      fachada.hideLoadingOverlay();
    });

    socket.on("remote-operation", (opData) => {
      try {
        // app.repository.bypassConfirmation = true;

        isRemoteChange = true;

        const operation = flatted.parse(opData);

        app.repository.doOperation(operation);

        app.diagrams.repaint();
      } finally {
        isRemoteChange = false;
        // app.repository.bypassConfirmation = false;
      }
    });

    socket.on("user-left", (id) => {
      console.log(`User ${users[id]} left.`);
      fachada.INFO(`${users[id]} left`);
      delete users[id];
      mm_view.removeCursor(id);
    });

    socket.on("remote-undo", () => {
      try {
        isRemoteChange = true;
        app.commands.execute("edit:undo");
      } finally {
        isRemoteChange = false;
      }
    });

    socket.on("remote-redo", () => {
      try {
        isRemoteChange = true;
        app.commands.execute("edit:redo");
      } finally {
        isRemoteChange = false;
      }
    });

    socket.on("element-locked", ({ viewId, ownerId }) => {});

    socket.on("element-locked", ({ viewId }) => {});

    socket.on("connect", () => {
      console.log("[LiveShare] Connected with ID:", socket.id);
      address = url;

      mm_net.addMouseMovementSharing(sendMousePosition);
      fachada.showLoadingOverlay();
      addChangesHook();
      resolve(true);
    });

    socket.on("connect_error", (err) => {
      console.error("[LiveShare] Connection error:", err);
      resolve(false); // Resolvemos como false para que la app no explote
    });
  });
}

function addChangesHook() {
  app.repository.on("operationExecuted", (operation) => {
    if (isRemoteChange) return;
    if (app.repository.bypassConfirmation) return;

    if (socket && socket.connected) {
      const str = flatted.stringify(operation);
      socket.emit("sync-operation", str);
    }
  });

  app.commands.on("afterExecute", (commandId, args, result) => {
    if (isRemoteChange) return;

    if (commandId === "edit:undo") {
      socket.emit("sync-undo");
    } else if (commandId === "edit:redo") {
      socket.emit("sync-redo");
    }
  });

  app.selections.on("selectionChanged", (models, views) => {
    if (views.length > 0) {
      socket.emit("lock-element", { viewIds: views.map((v) => v._id) });
    } else {
      socket.emit("unlock-elements");
    }
  });
}

function removeChangesHook() {
  app.repository.on("operationExecuted", (operation) => {});
}

//data: {x:_, y:_, diagram:_}
function sendMousePosition({ x, y, diagram }) {
  if (!(socket && socket.connected)) return;
  data = {
    id: socket.id,
    x: x,
    y: y,
    diagram: diagram,
  };
  socket.emit("client-mouse-moved", data);
}

function getConnectedAddress() {
  return address;
}

function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  address = "";
  mm_net.removeMouseMovementSharing();
  mm_view.removeAllCursors();
  fachada.enableHostOptions();
  removeChangesHook();
}
module.exports = {
  connectToServer: connectToServer,
  sendMousePosition: sendMousePosition,
  disconnect: disconnect,
  getConnectedAddress: getConnectedAddress,
  sendMousePosition: sendMousePosition,
};
