const io = require("socket.io-client"); //socket.io
const fachada = require("./fachada.js");
const flatted = require("flatted"); //stringify json
const cursors_js = require("./cursors.js");

let cursors = new cursors_js.CursorsHandler();
let socket = null;
let current_room = null;
let address = ""; // for copy-session-link
let users = {}; // for logging when users leave
let am_i_host = false;
let isRemoteChange = false;
let isLocalUndo = false;
let activeHighlights = {};
let followingUserId = null;
let userUpdateCallback = null;
let originalGridVisible = true;
let originalBackground = "";
let followOverlay = null;
let originalExecute = null;
let followStyleElement = null;

// Last known mouse state for viewport-only syncs
let lastKnownMouse = { x: 0, y: 0, diagram: null };
let lastSentViewport = { originX: 0, originY: 0, zoom: 0, diagram: null };
let lastViewportSyncTime = 0;
let viewportWatcherInterval = null;
const VIEWPORT_SYNC_THROTTLE = 30; // ms (Faster sync)
const VIEWPORT_CHECK_INTERVAL = 50; // ms (20 FPS for smoother tracking)

// Camera state
let targetCamera = { x: 0, y: 0, zoom: 1, diagram: null };
let currentCamera = { x: 0, y: 0, zoom: 1 };
let followAnimationFrame = null; // Still used for SHORT transitions if needed, but not persistent loop

const ZOOM_PRECISION = 0.001;
const SCROLL_PRECISION = 1.0;
const LERP_SPEED = 0.3; // Speed for one-shot smooth transition

async function connectToServer(url, name, roomid) {
  removeChangesHook();

  return new Promise((resolve, reject) => {
    socket = io(url, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
      auth: { username: name, room: roomid },
    });

    if (roomid && roomid !== -1) current_room = roomid;

    socket.on("user-joined", (data) => {
      if (!users[data.id]) users[data.id] = data.name;
      fachada.INFO(`${data.name} joined`);
      if (userUpdateCallback) userUpdateCallback();
    });

    socket.on("current-users", (data) => {
      console.log("[LS] Received current-users:", data);
      data.forEach((u) => {
        if (!users[u.id]) users[u.id] = u.name;
      });
      console.log("[LS] Users object after current-users:", users);
      if (userUpdateCallback) {
        console.log("[LS] Calling userUpdateCallback");
        userUpdateCallback();
      }
    });

    socket.on("is-host", (is_host) => {
      am_i_host = is_host;
      if (!am_i_host) fachada.disableHostOptions();
      if (am_i_host) fachada.hideLoadingOverlay();
      if (am_i_host) fachada.INFO("You're the host");
    });

    socket.on("host-left", (data) => {
      console.log("[LS] Host left the session");
      fachada.WARN("Host left the session");
      disconnect();
    });

      socket.on("room-assigned", async (id) => {
        console.log("[LS] Room assigned: " + current_room);
  
        current_room = id;
        addChangesHook();
        startViewportWatcher(); // Start watching viewport changes
        fachada.hideLoadingOverlay();
        resolve(true);
      });

    socket.on("update-mouse-pos", (data) => {
      if (data.id == socket.id) return;

      cursors.updateMousePosition(data);
      
      // Highlight the followed user's cursor
      if (followingUserId) {
        cursors.setHighlight(followingUserId);
      } else {
        cursors.setHighlight(null);
      }

      if (followingUserId === data.id) {
        applyViewportSync(data);
      }
    });

    socket.on("get-follow-sync", (data) => {
      // Someone is following me, send them my current position
      if (socket && socket.connected) {
        const viewport = getCurrentViewportData();
        socket.emit("response-follow-sync", {
          requesterId: data.requesterId,
          viewportData: viewport
        });
      }
    });

    socket.on("follower-sync-data", (data) => {
      if (followingUserId === data.id) {
        console.info("[LS] Applying initial follow sync from", data.id);
        const viewportData = data.viewportData || data;
        applyViewportSync({
          id: data.id,
          diagram: viewportData.diagram,
          x: viewportData.x,
          y: viewportData.y,
          zoom: viewportData.zoom,
          originX: viewportData.originX,
          originY: viewportData.originY
        }, true);
      }
    });

    socket.on("get-whole-document", (data) => {
      try {
        const projectObj = app.project.getProject();
        const cleanObject = app.repository.writeObject(projectObj);
        const str = flatted.stringify(cleanObject);
        socket.emit("host-delivers-document", {
          to: data.requesterId,
          json: str,
        });
      } catch (err) {
        fachada.ERR("Error sending whole document.");
      }
    });

    socket.on("load-whole-document", (data) => {
      try {
        const projectObj = flatted.parse(data.json);

        // --- Save workspace state (defensive) ---
        let openDiagramIds = [];
        let activeDiagramId = null;
        try {
          if (app.diagrams.getWorkingDiagrams) {
            openDiagramIds = app.diagrams.getWorkingDiagrams().map((d) => d._id);
          }
          if (app.diagrams.getCurrentDiagram()) {
            activeDiagramId = app.diagrams.getCurrentDiagram()._id;
          }
        } catch (e) {
          console.warn("[LS] Could not save workspace state", e);
        }

        app.repository.bypassConfirmation = true;
        app.project.loadFromJson(projectObj);
        app.repository.bypassConfirmation = false;

        // --- Restore workspace state ---
        try {
          openDiagramIds.forEach((id) => {
            const diag = app.repository.get(id);
            if (diag && diag instanceof type.Diagram) {
              app.diagrams.openDiagram(diag);
            }
          });
          if (activeDiagramId) {
            const diag = app.repository.get(activeDiagramId);
            if (diag && diag instanceof type.Diagram) {
              app.diagrams.setCurrentDiagram(diag);
            }
          }
        } catch (e) {
          console.warn("[LS] Could not restore workspace state", e);
        }

        fachada.INFO("Document synchronized.");
      } catch (err) {
        fachada.ERR("Error loading remote document:", err);
        console.error(err);
      } finally {
        fachada.hideLoadingOverlay();
      }
    });

    socket.on("remote-operation", (opData) => {
      isRemoteChange = true;
      try {
        const operation = flatted.parse(opData);
        app.repository.doOperation(operation);
        app.diagrams.repaint();

        updateAllHighlights();
      } catch (err) {
        console.error("[LS] Operation Error:", err);
      } finally {
        isRemoteChange = false;
      }
    });

    socket.on("remote-undo", async () => {
      isRemoteChange = true;
      try {
        const undoManager = app.repository._undoManager || app.repository._operationManager;
        if (undoManager && typeof undoManager.undo === 'function') {
          await undoManager.undo();
          app.diagrams.repaint();
          updateAllHighlights();
        } else if (app.repository._undoStack && app.repository._undoStack.length > 0) {
          const lastOp = app.repository._undoStack[app.repository._undoStack.length - 1];
          app.repository.rollback(lastOp);
          app.diagrams.repaint();
          updateAllHighlights();
        } else {
          console.log("[LS] Remote undo - no operations to undo");
        }
      } catch (e) {
        console.error("[LS] Remote undo failed:", e);
      } finally {
        isRemoteChange = false;
      }
    });

    socket.on("remote-redo", async () => {
      isRemoteChange = true;
      try {
        const undoManager = app.repository._undoManager || app.repository._operationManager;
        if (undoManager && typeof undoManager.redo === 'function') {
          await undoManager.redo();
          app.diagrams.repaint();
          updateAllHighlights();
        } else if (app.repository._redoStack && app.repository._redoStack.length > 0) {
          const lastOp = app.repository._redoStack[app.repository._redoStack.length - 1];
          app.repository.commit(lastOp);
          app.diagrams.repaint();
          updateAllHighlights();
        } else {
          console.log("[LS] Remote redo - no operations to redo");
        }
      } catch (e) {
        console.error("[LS] Remote redo failed:", e);
      } finally {
        isRemoteChange = false;
      }
    });

    // Handle Undo/Redo synchronization to prevent double-syncing
    if (!originalExecute) {
      originalExecute = app.commands.execute;
      app.commands.execute = function (id, ...args) {
        if (id === "edit:undo" || id === "edit:redo") {
          isLocalUndo = true;
          try {
            return originalExecute.apply(app.commands, [id, ...args]);
          } finally {
            isLocalUndo = false;
          }
        }
        return originalExecute.apply(app.commands, [id, ...args]);
      };
    }

    socket.on("element-locked", ({ viewId, ownerId, color }) => {
      if (ownerId !== socket.id) {
        highlightElement(viewId, color);
      }
    });

    socket.on("element-unlocked", ({ viewId }) => {
      removeHighlight(viewId);
    });

    socket.on("user-left", (id) => {
      const userName = users[id] || "User";
      fachada.INFO(`${userName} left`);
      delete users[id];
      cursors.removeCursor(id);
      if (followingUserId === id) {
        removeFollowEffects();
        followingUserId = null;
      }
      if (userUpdateCallback) userUpdateCallback();
    });

    socket.on("connect", () => {
      address = url;
      cursors.addMouseMovementSharing(sendMousePosition);
      fachada.showLoadingOverlay();
      if (socket.recovered) {
        fachada.INFO("Connection recovered!");
      }
    });

    socket.on("disconnect", (reason) => {
      console.log("[LS] Socket disconnected, reason:", reason);
      if (reason === "io server disconnect") {
        disconnect();
      } else if (reason === "transport close") {
        disconnect();
      } else {
        removeAllHighlights();
        cursors.removeAllCursors();
      }
    });

    socket.on("reconnect", (attempt) => {
      fachada.INFO("Reconnected after " + attempt + " attempts.");
    });

    socket.on("connect_error", (err) => {
      console.error("Connect Error:", err);
      resolve(false);
    });

    // Handle visibility change to prevent throttling issues
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && socket && socket.connected) {
        socket.emit("client-ping", { timestamp: Date.now() });
      }
    });
  });
}

const handleOperation = (operation) => {
  if (isRemoteChange || isLocalUndo || app.repository.bypassConfirmation)
    return;
  if (socket && socket.connected && current_room) {
    const str = flatted.stringify(operation);
    socket.emit("sync-operation", str);
  }
};

const handleSelection = (models, views) => {
  if (!socket || !socket.connected) return;
  if (views && views.length > 0) {
    socket.emit(
      "lock-element",
      views.map((v) => v._id),
    );
  } else {
    socket.emit("unlock-elements");
  }
};

const handleCommands = (commandId) => {
  // If it's a remote change, don't re-emit.
  // We DO allow emission if it's isLocalUndo because we blocked its individual operations in handleOperation.
  if (isRemoteChange || !socket || !socket.connected) return;
  if (commandId === "edit:undo") socket.emit("sync-undo");
  else if (commandId === "edit:redo") socket.emit("sync-redo");
};

function addChangesHook() {
  removeChangesHook();

  app.repository.on("operationExecuted", handleOperation);
  app.commands.on("afterExecute", handleCommands);
  app.selections.on("selectionChanged", handleSelection);
  app.diagrams.on("currentDiagramChanged", () => {
    updateAllHighlights();
    syncViewportThrottled();
  });

  // For zoom/scroll updates
  const diagramArea = app.diagrams.$diagramArea[0];
  if (diagramArea) {
    diagramArea.addEventListener("wheel", onDiagramWheel, { passive: true });
    diagramArea.addEventListener("mousedown", onDiagramMouseDown);
  }
}

function onDiagramWheel() {
  updateAllHighlights();
  checkViewportChange(); // Immediate check on wheel
}

function checkViewportChange() {
  const currentDiagram = app.diagrams.getCurrentDiagram();
  if (!currentDiagram) return;

  const zoom = app.diagrams.getZoomLevel();
  const originX = currentDiagram._originX;
  const originY = currentDiagram._originY;
  const diagId = currentDiagram._id;

  const changed = 
    Math.abs(lastSentViewport.originX - originX) > 0.1 ||
    Math.abs(lastSentViewport.originY - originY) > 0.1 ||
    Math.abs(lastSentViewport.zoom - zoom) > 0.001 ||
    lastSentViewport.diagram !== diagId;

  if (changed) {
    syncViewportThrottled();
    
    // Update last sent state
    lastSentViewport.originX = originX;
    lastSentViewport.originY = originY;
    lastSentViewport.zoom = zoom;
    lastSentViewport.diagram = diagId;
  }
}

function startViewportWatcher() {
  stopViewportWatcher();

  // Initialize state immediately to avoid sending nulls
  const currentDiagram = app.diagrams.getCurrentDiagram();
  if (currentDiagram) {
    const zoom = app.diagrams.getZoomLevel();
    lastSentViewport = {
      originX: currentDiagram._originX,
      originY: currentDiagram._originY,
      zoom: zoom,
      diagram: currentDiagram._id
    };
    
    // Also initialize lastKnownMouse if null
    if (!lastKnownMouse.diagram) {
      lastKnownMouse.diagram = currentDiagram._id;
      // Default mouse to host origin
      lastKnownMouse.x = currentDiagram._originX;
      lastKnownMouse.y = currentDiagram._originY;
    }
  }

  viewportWatcherInterval = setInterval(checkViewportChange, VIEWPORT_CHECK_INTERVAL);
}

function stopViewportWatcher() {
  if (viewportWatcherInterval) {
    clearInterval(viewportWatcherInterval);
    viewportWatcherInterval = null;
  }
}

function syncViewportThrottled() {
  const now = Date.now();
  if (now - lastViewportSyncTime >= VIEWPORT_SYNC_THROTTLE) {
    sendMousePosition(lastKnownMouse);
    lastViewportSyncTime = now;
  }
}

function removeChangesHook() {
  app.repository.off("operationExecuted", handleOperation);
  app.commands.off("afterExecute", handleCommands);
  app.selections.off("selectionChanged", handleSelection);
  app.diagrams.off("currentDiagramChanged", updateAllHighlights);

  const diagramArea = app.diagrams.$diagramArea[0];
  if (diagramArea) {
    diagramArea.removeEventListener("wheel", updateAllHighlights);
    diagramArea.removeEventListener("mousedown", onDiagramMouseDown);
  }
}

let isPanning = false;
function onDiagramMouseDown() {
  isPanning = true;
  const onMouseMove = () => {
    if (isPanning) {
        updateAllHighlights();
        syncViewportThrottled();
    }
  };
  const onMouseUp = () => {
    isPanning = false;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  };
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}

// Highlights
function highlightElement(viewId, color) {
  const view = app.repository.get(viewId);
  const diagramArea = app.diagrams.$diagramArea[0];

  if (view && view instanceof type.View) {
    removeHighlight(viewId);

    const hl = document.createElement("div");
    hl.className = "element-lock-highlight";
    hl.style.cssText = `
      position: absolute;
      border: 3px solid ${color};
      pointer-events: none;
      z-index: 5;
      box-sizing: border-box;
      display: none;
    `;
    diagramArea.appendChild(hl);
    activeHighlights[viewId] = { element: hl, color: color };
    updateAllHighlights();
  }
}

function removeHighlight(viewId) {
  if (activeHighlights[viewId]) {
    activeHighlights[viewId].element.remove();
    delete activeHighlights[viewId];
  }
}

function removeAllHighlights() {
  for (let viewId in activeHighlights) {
    activeHighlights[viewId].element.remove();
  }
  activeHighlights = {};
}

function updateAllHighlights() {
  const currentDiagram = app.diagrams.getCurrentDiagram();
  if (!currentDiagram) {
    for (let viewId in activeHighlights) {
      activeHighlights[viewId].element.style.display = "none";
    }
    return;
  }

  const zoom = app.diagrams.getZoomLevel();
  const originX = currentDiagram._originX;
  const originY = currentDiagram._originY;

  for (let viewId in activeHighlights) {
    const view = app.repository.get(viewId);
    if (view && view instanceof type.View && view._parent === currentDiagram) {
      const hlObj = activeHighlights[viewId];
      const hl = hlObj.element;

      const physicalX = (view.left + originX) * zoom;
      const physicalY = (view.top + originY) * zoom;
      const physicalW = view.width * zoom;
      const physicalH = view.height * zoom;

      hl.style.left = `${physicalX}px`;
      hl.style.top = `${physicalY}px`;
      hl.style.width = `${physicalW}px`;
      hl.style.height = `${physicalH}px`;
      hl.style.display = "block";
    } else {
      activeHighlights[viewId].element.style.display = "none";
    }
  }
}

function sendMousePosition(mouseData) {
  if (!(socket && socket.connected)) return;

  try {
    const { x, y, diagram } = mouseData;
    
    // Update cache
    lastKnownMouse.x = x;
    lastKnownMouse.y = y;
    lastKnownMouse.diagram = diagram;

    const zoom = app.diagrams.getZoomLevel();
    const currentDiagram = app.diagrams.getCurrentDiagram();
    const originX = currentDiagram ? currentDiagram._originX : 0;
    const originY = currentDiagram ? currentDiagram._originY : 0;

    socket.emit("client-mouse-moved", {
      id: socket.id,
      x: x,
      y: y,
      diagram: diagram,
      zoom: zoom,
      originX: originX,
      originY: originY
    });
  } catch (e) {
    console.error("[LS] Error sending mouse position:", e);
  }
}

function requestDocument() {
  if (!(socket && socket.connected)) return;
  fachada.showLoadingOverlay();
  socket.emit("request-doc");
}

function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  address = "";
  current_room = null;
  stopViewportWatcher();
  removeAllHighlights();
  cursors.removeMouseMovementSharing();
  cursors.removeAllCursors();
  removeFollowEffects();
  fachada.enableHostOptions();
  removeChangesHook();
  users = {};
  am_i_host = false;
  followingUserId = null;

  if (originalExecute) {
    app.commands.execute = originalExecute;
    originalExecute = null;
  }

  notifyDisconnect();
}

// getters
function getConnectedAddress() {
  return address;
}

function getCurrentRoom() {
  return current_room;
}

function getUsers() {
  return users;
}

function getSocketId() {
  return socket ? socket.id : null;
}

function getFollowingUserId() {
  return followingUserId;
}

function setFollowingUserId(id) {
  if (followingUserId && !id) {
    // Restore grid visibility if we were following
    try {
      app.preferences.set("diagramEditor.showGrid", originalGridVisible);
    } catch (e) { console.warn("[LS] Could not restore grid preference"); }
    
    removeFollowEffects();
    stopFollowAnimation();
  } else if (!followingUserId && id) {
    // Save current grid visibility and force it to be ON while following
    try {
      originalGridVisible = app.preferences.get("diagramEditor.showGrid");
      app.preferences.set("diagramEditor.showGrid", true);
    } catch (e) { console.warn("[LS] Could not manage grid preference"); }

    // initialize current camera to actual current state
    const diag = app.diagrams.getCurrentDiagram();
    if (diag) {
      currentCamera.x = diag._originX;
      currentCamera.y = diag._originY;
      currentCamera.zoom = app.diagrams.getZoomLevel();
    }
    applyFollowEffects(id);

    // Request initial position
    if (socket && socket.connected) {
      console.log("[LS] Requesting initial follow sync from:", id);
      socket.emit("request-follow-sync", { targetId: id });
    }
  } else if (followingUserId && id && followingUserId !== id) {
    // Switching who to follow - keep grid treatment but update effects
    applyFollowEffects(id);
    
    // Request initial position for the new target
    if (socket && socket.connected) {
      socket.emit("request-follow-sync", { targetId: id });
    }
  }

  followingUserId = id;
}

function getCurrentViewportData() {
  try {
    const currentDiagram = app.diagrams.getCurrentDiagram();
    const zoom = app.diagrams.getZoomLevel();
    return {
      x: lastKnownMouse.x,
      y: lastKnownMouse.y,
      diagram: currentDiagram ? currentDiagram._id : null,
      zoom: zoom,
      originX: currentDiagram ? currentDiagram._originX : 0,
      originY: currentDiagram ? currentDiagram._originY : 0
    };
  } catch (e) {
    console.error("[LS] Error getting current viewport data:", e);
    return null;
  }
}

const FOLLOW_SCROLL_THRESHOLD = 200;

function applyViewportSync(data, force = false) {
  try {
    const currentDiagram = app.diagrams.getCurrentDiagram();
    const currentZoom = app.diagrams.getZoomLevel();
    const zoom = data.zoom || currentZoom;
    
    let mouseX, mouseY;
    if (data.x !== undefined && data.y !== undefined) {
      mouseX = data.x;
      mouseY = data.y;
    } else if (data.originX !== undefined && data.originY !== undefined) {
      mouseX = data.originX + (data.x || 0);
      mouseY = data.originY + (data.y || 0);
    } else {
      mouseX = 0;
      mouseY = 0;
    }
    
    const diagramArea = app.diagrams.$diagramArea[0];
    const canvas = diagramArea ? diagramArea.querySelector('svg') : null;
    const viewWidth = canvas ? canvas.clientWidth : (window.innerWidth - 220);
    const viewHeight = canvas ? canvas.clientHeight : window.innerHeight;
    const targetOriginX = mouseX - (viewWidth / 2) / zoom;
    const targetOriginY = mouseY - (viewHeight / 2) / zoom;
    
    if (data.diagram && (!currentDiagram || currentDiagram._id !== data.diagram)) {
      const targetDiag = app.repository.get(data.diagram);
      if (targetDiag && targetDiag instanceof type.Diagram) {
        app.diagrams.setCurrentDiagram(targetDiag);
        app.diagrams.repaint();
        currentCamera.x = targetOriginX;
        currentCamera.y = targetOriginY;
        currentCamera.zoom = zoom;
      }
    }

    targetCamera.x = targetOriginX;
    targetCamera.y = targetOriginY;
    targetCamera.zoom = zoom;
    targetCamera.diagram = data.diagram;

    const zoomDiff = Math.abs(targetCamera.zoom - currentZoom);
    const scrollXDiff = Math.abs(targetCamera.x - (currentDiagram ? currentDiagram._originX : 0));
    const scrollYDiff = Math.abs(targetCamera.y - (currentDiagram ? currentDiagram._originY : 0));

    const shouldScroll = force || (!isPanning && (zoomDiff > ZOOM_PRECISION || scrollXDiff > FOLLOW_SCROLL_THRESHOLD || scrollYDiff > FOLLOW_SCROLL_THRESHOLD));
    
    if (shouldScroll) {
      if (zoomDiff > ZOOM_PRECISION || force) {
        app.diagrams.setZoomLevel(targetCamera.zoom);
      }
      
      app.diagrams.scrollTo(targetCamera.x, targetCamera.y);
      
      currentCamera.x = targetCamera.x;
      currentCamera.y = targetCamera.y;
      currentCamera.zoom = targetCamera.zoom;

      updateAllHighlights();
    }
  }
  catch (e) {
    console.error("[LS] Error syncing viewport following user:", e);
  }
}

function startFollowAnimation() {
  // No longer using persistent animation loop to avoid overriding StarUML's internal state
  // and causing the "white screen" and coordinate locking bug.
}

function stopFollowAnimation() {
  if (followAnimationFrame) {
    cancelAnimationFrame(followAnimationFrame);
    followAnimationFrame = null;
  }
}

function applyFollowEffects(targetId) {
  try {
    const userName = users[targetId] || "User";
    
    // Remove existing overlay if any
    if (followOverlay) {
      followOverlay.remove();
    }

    // Create a premium "Following" overlay
    followOverlay = document.createElement("div");
    followOverlay.id = "ls-follow-overlay";
    followOverlay.style.cssText = `
      position: absolute;
      top: 15px;
      right: 15px;
      padding: 6px 12px;
      background: #252525;
      border: 1px solid #444;
      border-left: 3px solid #f1c40f;
      border-radius: 2px;
      color: #ebebeb;
      font-family: 'Open Sans', sans-serif;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 10px;
      z-index: 1000;
      box-shadow: 0 4px 10px rgba(0,0,0,0.4);
      pointer-events: auto;
      transition: all 0.3s ease;
      animation: ls-slide-in 0.3s ease;
    `;

    followStyleElement = document.createElement('style');
    followStyleElement.innerHTML = `
      @keyframes ls-slide-in {
        from { transform: translateX(20px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes ls-pulse {
        0% { transform: scale(1); opacity: 0.8; }
        50% { transform: scale(1.3); opacity: 0.4; }
        100% { transform: scale(1); opacity: 0.8; }
      }
    `;
    document.head.appendChild(followStyleElement);

    followOverlay.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <div style="width: 6px; height: 6px; background: #f1c40f; border-radius: 50%; animation: ls-pulse 2s infinite;"></div>
        <span style="font-weight: 400; color: #888; text-transform: uppercase; font-size: 9px; letter-spacing: 1px;">Following</span>
        <span style="font-weight: 400; color: #fff; font-size: 12px;">${userName}</span>
      </div>
      <div id="ls-stop-follow" style="
        cursor: pointer;
        padding: 2px 6px;
        background: rgba(255, 255, 255, 0.05);
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 2px;
        font-size: 10px;
        color: #888;
        transition: all 0.2s;
      " title="Stop following" onmouseover="this.style.color='#fff';this.style.background='rgba(255,0,0,0.2)'" onmouseout="this.style.color='#888';this.style.background='rgba(255,255,255,0.05)'">✕</div>
    `;

    const diagramArea = app.diagrams.$diagramArea[0];
    if (diagramArea) {
      diagramArea.appendChild(followOverlay);
      
      document.getElementById("ls-stop-follow").onclick = (e) => {
        e.stopPropagation();
        setFollowingUserId(null);
        if (userUpdateCallback) userUpdateCallback(); // Refresh UI panel
      };
    }
  } catch (e) {
    console.error("[LS] Error applying follow effects:", e);
  }
}

function removeFollowEffects() {
  try {
    if (followOverlay) {
      followOverlay.style.opacity = "0";
      followOverlay.style.transform = "translateX(20px)";
      setTimeout(() => {
        if (followOverlay) {
          followOverlay.remove();
          followOverlay = null;
        }
      }, 300);
    }
    if (followStyleElement) {
      followStyleElement.remove();
      followStyleElement = null;
    }
  } catch (e) {
    console.error("[LS] Error removing follow effects:", e);
  }
}

let disconnectCallback = null;

function onUserUpdate(callback) {
  userUpdateCallback = callback;
}

function onDisconnect(callback) {
  disconnectCallback = callback;
}

function notifyDisconnect() {
  if (disconnectCallback) disconnectCallback();
}

module.exports = {
  connectToServer,
  sendMousePosition,
  disconnect,
  getConnectedAddress,
  requestDocument,
  getCurrentRoom,
  getUsers,
  getSocketId,
  getFollowingUserId,
  setFollowingUserId,
  onUserUpdate,
  onDisconnect,
};
