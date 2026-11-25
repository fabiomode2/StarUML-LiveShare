const io = require('socket.io-client');
const fachada = require('./fachada.js');
const flatted = require('flatted');
const cursors_js = require('./cursors.js');

let cursors = new cursors_js.CursorsHandler();
let socket = null;
let current_room = null;
let address = '';
let users = {};
let am_i_host = false;
let remoteOpInProgress = false;
let activeHighlights = {};
let followingUserId = null;
let userUpdateCallback = null;
let originalGridVisible = true;
let followOverlay = null;
let followStyleElement = null;

let lastKnownMouse = { x: null, y: null, diagram: null };
let lastSentViewport = { originX: 0, originY: 0, zoom: 0, diagram: null };
let lastViewportSyncTime = 0;
let viewportWatcherInterval = null;
const SIDEBAR_WIDTH = 220;
const VIEWPORT_SYNC_THROTTLE = 30;
const VIEWPORT_CHECK_INTERVAL = 50;
const REMOTE_OP_DEBOUNCE_MS = 150;
const PROMOTION_DOC_TIMEOUT_MS = 4000;
const LERP_SPEED = 0.3;

let targetCamera = { x: 0, y: 0, zoom: 1, diagram: null };
let followAnimationFrame = null;
let promotionDocTimer = null;

const ZOOM_PRECISION = 0.001;

let lastAppliedSeq = 0;
let documentSynced = false;
let documentLoaded = false;
let lastKnownRoomSeq = 0;
let ownOpLog = [];
let retainedRoom = null;
let retainedSeq = 0;
let selectionDebounceTimer = null;
let remoteOpEndTime = 0;
let pendingGapOp = null;
let lastFailedApplySeq = null;
let lastFailedApplyAt = 0;
const MAX_OWN_OP_LOG = 200;
let syncOpEmissionCount = 0;
let syncAckCount = 0;
let serverSupportsSyncAck = false;
let currentLatency = -1;
let latencyUpdateCallback = null;

async function connectToServer(url, name, roomid) {
  removeChangesHook();
  serverSupportsSyncAck = false;

  return new Promise((resolve, reject) => {
    socket = io(url, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
      auth: { username: name, room: roomid },
    });

    if (roomid && roomid !== -1) current_room = roomid;

    socket.on('user-joined', (data) => {
      if (!users[data.id]) users[data.id] = data.name;
      fachada.INFO(`${data.name} joined`);
      if (userUpdateCallback) userUpdateCallback();
    });

    socket.on('current-users', (data) => {
      console.log('[LS] Received current-users:', data);
      data.forEach((u) => {
        if (!users[u.id]) users[u.id] = u.name;
      });
      if (am_i_host && data.length === 0 && !documentLoaded) {
        documentLoaded = true;
        socket.emit('doc-ready', { seq: lastAppliedSeq });
      }
      if (userUpdateCallback) userUpdateCallback();
    });

    socket.on('is-host', (is_host) => {
      const wasHost = am_i_host;
      am_i_host = is_host;
      if (!am_i_host) {
        fachada.disableHostOptions();
        return;
      }
      fachada.enableHostOptions();
      fachada.INFO("You're the host");
      if (!wasHost && documentLoaded) {
        fachada.showLoadingOverlay();
        if (promotionDocTimer) clearTimeout(promotionDocTimer);
        promotionDocTimer = setTimeout(() => {
          promotionDocTimer = null;
          fachada.hideLoadingOverlay();
        }, PROMOTION_DOC_TIMEOUT_MS);
      }
      documentSynced = true;
    });

    socket.on('host-left', () => {
      console.log('[LS] Host left, session continues with new host');
      fachada.WARN('Host changed. A new host has been assigned.');
    });

    socket.on('new-host', (newHostId) => {
      console.log('[LS] New host assigned:', newHostId);
      if (users[newHostId]) {
        fachada.INFO(`${users[newHostId]} is now the host`);
      }
    });

    socket.on('room-assigned', async (id) => {
      console.log('[LS] Room assigned: ' + id);
      current_room = id;
      addChangesHook();
      startViewportWatcher();
      fachada.hideLoadingOverlay();
      resolve(true);
    });

    socket.on('latency-response', () => {
      currentLatency = Math.round(Date.now() - lastPingTime);
      if (latencyUpdateCallback) latencyUpdateCallback(currentLatency);
    });

    socket.on('room-seq', (currentSeq) => {
      lastKnownRoomSeq = currentSeq;
      const retainedRegressed =
        current_room === retainedRoom &&
        retainedSeq > 0 &&
        currentSeq < retainedSeq;
      if (
        (currentSeq < lastAppliedSeq || retainedRegressed) &&
        documentLoaded
      ) {
        console.log(
          `[LS] Sequence reset: was ${Math.max(lastAppliedSeq, retainedSeq)}, now ${currentSeq}`,
        );
        lastAppliedSeq = 0;
        documentSynced = false;
        documentLoaded = false;
        pendingGapOp = null;
        lastFailedApplySeq = null;
        lastFailedApplyAt = 0;
        ownOpLog = [];
        retainedRoom = null;
        retainedSeq = 0;
        requestDocument();
      }
      if (
        currentSeq > lastAppliedSeq &&
        documentSynced &&
        documentLoaded &&
        !pendingGapOp
      ) {
        if (current_room === retainedRoom && retainedSeq > 0) {
          if (currentSeq <= retainedSeq) {
            console.log(
              `[LS] Retained repo already has ops up to ${retainedSeq}, advancing`,
            );
            lastAppliedSeq = currentSeq;
            return;
          }
          console.log(
            `[LS] Room advanced beyond retained ${retainedSeq}, catching up`,
          );
          lastAppliedSeq = Math.max(lastAppliedSeq, retainedSeq);
          retainedRoom = null;
          retainedSeq = 0;
        }
        console.log(
          `[LS] Requesting missed ops: ${lastAppliedSeq + 1} to ${currentSeq}`,
        );
        socket.emit('request-missed-ops', { fromSeq: lastAppliedSeq });
      }
    });

    socket.on('missed-ops', (data) => {
      const gapOp = pendingGapOp;
      pendingGapOp = null;
      if (!data.ops || data.ops.length === 0) {
        if (gapOp) {
          console.warn('[LS] Missed ops reply empty, dropped queued gap op');
        }
        if (lastKnownRoomSeq > lastAppliedSeq) {
          console.warn('[LS] Missed ops unavailable, requesting full document');
          requestDocument();
        }
        return;
      }
      console.log(`[LS] Applying ${data.ops.length} missed operations`);
      data.ops.sort((a, b) => a.seq - b.seq);
      let expectedSeq = lastAppliedSeq;
      let headGap = false;
      for (const entry of data.ops) {
        if (entry.seq <= expectedSeq) continue;
        if (entry.seq > expectedSeq + 1) {
          headGap = true;
          break;
        }
        expectedSeq = entry.seq;
      }
      if (headGap) {
        console.warn(
          '[LS] Missed ops reply is not contiguous (history pruned), requesting full document',
        );
        requestDocument();
        return;
      }
      let applyFailed = false;
      let failedSeq = null;
      data.ops.forEach((entry) => {
        if (entry.socketId === socket.id) {
          if (applyFailed) return;
          lastAppliedSeq = Math.max(lastAppliedSeq, entry.seq);
          return;
        }
        if (entry.seq <= lastAppliedSeq) return;
        if (!applyRemoteOperationWithSeq(entry.seq, entry.operation)) {
          applyFailed = true;
          if (failedSeq === null) failedSeq = entry.seq;
        }
      });
      if (applyFailed) {
        const repeatedWithinWindow =
          failedSeq === lastFailedApplySeq &&
          Date.now() - lastFailedApplyAt < 5000;
        if (repeatedWithinWindow) {
          console.error(
            `[LS] Operation ${failedSeq} failed again, not requesting another document yet`,
          );
          return;
        }
        lastFailedApplySeq = failedSeq;
        lastFailedApplyAt = Date.now();
        console.warn(
          '[LS] Failed to apply a missed operation, requesting full document',
        );
        requestDocument(true);
        return;
      }
      lastFailedApplySeq = null;
      if (lastAppliedSeq < lastKnownRoomSeq) {
        const roomSeqAtReply = lastKnownRoomSeq;
        setTimeout(() => {
          if (lastAppliedSeq < roomSeqAtReply && socket && socket.connected) {
            console.warn(
              '[LS] Missed ops partial (history pruned), requesting full document',
            );
            requestDocument();
          }
        }, 300);
        return;
      }
      if (gapOp && !data.ops.some((entry) => entry.seq === gapOp.seq)) {
        console.warn(
          `[LS] Gap op seq ${gapOp.seq} not in history, requesting full document`,
        );
        if (lastKnownRoomSeq > lastAppliedSeq) requestDocument();
      }
    });

    socket.on('sync-ack', (data) => {
      serverSupportsSyncAck = true;
      syncAckCount++;
      const entry = ownOpLog.find((e) => e.emitIdx === syncAckCount - 1);
      if (entry) entry.seq = data.seq;
    });

    socket.on('sync-capabilities', (caps) => {
      serverSupportsSyncAck = caps && caps.syncAck === true;
    });

    socket.on('update-mouse-pos', (data) => {
      if (data.id === socket.id) return;
      cursors.updateMousePosition(data);
      if (followingUserId) {
        cursors.setHighlight(followingUserId);
      } else {
        cursors.setHighlight(null);
      }
      if (followingUserId === data.id) {
        applyViewportSync(data);
      }
    });

    socket.on('get-follow-sync', (data) => {
      if (socket && socket.connected) {
        const viewport = getCurrentViewportData();
        socket.emit('response-follow-sync', {
          requesterId: data.requesterId,
          viewportData: viewport,
        });
      }
    });

    socket.on('follower-sync-data', (data) => {
      if (followingUserId === data.id) {
        const viewportData = data.viewportData || data;

        applyViewportSync(
          {
            id: data.id,
            diagram: viewportData.diagram,
            x: viewportData.x,
            y: viewportData.y,
            zoom: viewportData.zoom,
            originX: viewportData.originX,
            originY: viewportData.originY,
          },
          true,
        );
      }
    });

    socket.on('get-whole-document', (data) => {
      try {
        const projectObj = app.project.getProject();
        const cleanObject = app.repository.writeObject(projectObj);
        const str = flatted.stringify(cleanObject);
        socket.emit('host-delivers-document', {
          to: data.requesterId,
          json: str,
          seq: lastAppliedSeq,
          forEviction: data.forEviction === true,
        });
      } catch (err) {
        fachada.ERR('Error sending whole document.');
      }
    });

    socket.on('load-whole-document', (data) => {
      const wasLoaded = documentLoaded;
      if (promotionDocTimer) {
        clearTimeout(promotionDocTimer);
        promotionDocTimer = null;
      }
      if (data.seq !== undefined && data.seq <= lastAppliedSeq && documentLoaded) {
        const evictionLoad =
          data.forEviction === true && current_room !== retainedRoom;
        if (!evictionLoad) {
          ownOpLog = [];
          socket.emit('doc-ready', { seq: lastAppliedSeq });
          fachada.hideLoadingOverlay();
          return;
        }
      }
      try {
        const projectObj = flatted.parse(data.json);

        let openDiagramIds = [];
        let activeDiagramId = null;
        try {
          if (app.diagrams.getWorkingDiagrams) {
            openDiagramIds = app.diagrams
              .getWorkingDiagrams()
              .map((d) => d._id);
          }
          if (app.diagrams.getCurrentDiagram()) {
            activeDiagramId = app.diagrams.getCurrentDiagram()._id;
          }
        } catch (e) {
          console.warn('[LS] Could not save workspace state', e);
        }

        app.repository.bypassConfirmation = true;
        try {
          app.project.loadFromJson(projectObj);
        } finally {
          app.repository.bypassConfirmation = false;
        }

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
          console.warn('[LS] Could not restore workspace state', e);
        }

        if (data.seq !== undefined) {
          lastAppliedSeq = data.seq;
        }
        documentSynced = true;
        documentLoaded = true;
        pendingGapOp = null;
        lastFailedApplySeq = null;
        lastFailedApplyAt = 0;
        retainedRoom = null;
        retainedSeq = 0;

        const pendingOwnOps = ownOpLog;
        ownOpLog = [];
        const loadedSeq = data.seq !== undefined ? data.seq : lastAppliedSeq;
        remoteOpInProgress = true;
        try {
          pendingOwnOps.forEach((entry) => {
            // seq <= loadedSeq means the snapshot already contains that op.
            // seq === null means the ack did not arrive before the snapshot.
            // With an older server (no sync acks), unknown ops are only
            // replayed while the initial document is loading; after that they
            // may already be in the snapshot, so replaying would duplicate.
            if (entry.seq !== null && entry.seq <= loadedSeq) return;
            if (entry.seq === null && !serverSupportsSyncAck && wasLoaded) {
              return;
            }
            try {
              app.repository.doOperation(entry.operation);
            } catch (e) {
              console.warn('[LS] Replay pending own op failed:', e);
            }
          });
        } finally {
          remoteOpInProgress = false;
        }
        app.diagrams.repaint();
        updateAllHighlights();
        socket.emit('doc-ready', { seq: lastAppliedSeq });

        if (data.seq !== undefined && lastKnownRoomSeq > data.seq) {
          socket.emit('request-missed-ops', { fromSeq: data.seq });
        }
        fachada.INFO('Document synchronized.');
      } catch (err) {
        fachada.ERR('Error loading remote document:', err);
        console.error(err);
      } finally {
        fachada.hideLoadingOverlay();
      }
    });

    socket.on('remote-operation', (data) => {
      const isOwn = data.socketId === socket.id;
      if (isOwn) {
        if (documentSynced && data.seq > lastAppliedSeq && !pendingGapOp) {
          lastAppliedSeq = data.seq;
        }
        app.diagrams.repaint();
        updateAllHighlights();
        return;
      }

      if (data.seq <= lastAppliedSeq) return;

      if (!documentSynced) return;

      if (data.seq > lastAppliedSeq + 1) {
        const hadGap = !!pendingGapOp;
        if (!hadGap || data.seq > pendingGapOp.seq) {
          pendingGapOp = { operation: data.operation, seq: data.seq };
        }
        if (!hadGap) {
          console.log(
            `[LS] Detected gap: ${lastAppliedSeq} -> ${data.seq}, queuing op and requesting missed ops`,
          );
          socket.emit('request-missed-ops', { fromSeq: lastAppliedSeq });
        }
        return;
      }

      remoteOpInProgress = true;
      try {
        const operation = flatted.parse(data.operation);
        app.repository.doOperation(operation);
        lastAppliedSeq = data.seq;
      } catch (err) {
        console.error('[LS] Operation Error:', err);
      } finally {
        remoteOpInProgress = false;
        remoteOpEndTime = Date.now();
        app.diagrams.repaint();
        updateAllHighlights();
      }
    });

    socket.on('element-locked', ({ viewId, ownerId, color }) => {
      if (ownerId !== socket.id) {
        highlightElement(viewId, color);
      }
    });

    socket.on('element-unlocked', ({ viewId }) => {
      removeHighlight(viewId);
    });

    socket.on('user-left', (id) => {
      const userName = users[id] || 'User';
      fachada.INFO(`${userName} left`);
      delete users[id];
      cursors.removeCursor(id);
      if (followingUserId === id) {
        removeFollowEffects();
        followingUserId = null;
      }
      if (userUpdateCallback) userUpdateCallback();
    });

    socket.on('connect', () => {
      address = url;
      // Acks for ops emitted before a reconnect are lost with the old socket.
      // Align the counters so the next ack still maps to its own emission.
      syncAckCount = syncOpEmissionCount;
      cursors.addMouseMovementSharing(sendMousePosition);
      fachada.showLoadingOverlay();
      startPingMeasurement();
    });

    socket.on('disconnect', (reason) => {
      console.log('[LS] Socket disconnected, reason:', reason);
      if (
        reason === 'io server disconnect' ||
        reason === 'io client disconnect' ||
        reason === 'transport close'
      ) {
        disconnect();
      } else {
        fachada.WARN('Connection lost. Reconnecting...');
        removeAllHighlights();
        cursors.removeAllCursors();
      }
    });

    socket.on('reconnect', (attempt) => {
      fachada.INFO('Reconnected after ' + attempt + ' attempts.');
    });

    socket.on('connect_error', (err) => {
      console.error('Connect Error:', err);
      resolve(false);
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && socket && socket.connected) {
        socket.emit('client-ping', { timestamp: Date.now() });
      }
    });
  });
}

function applyRemoteOperationWithSeq(seq, opStr) {
  if (seq <= lastAppliedSeq) return true;
  remoteOpInProgress = true;
  try {
    const operation = flatted.parse(opStr);
    app.repository.doOperation(operation);
    lastAppliedSeq = seq;
    return true;
  } catch (err) {
    console.error('[LS] Operation Error:', err);
    return false;
  } finally {
    remoteOpInProgress = false;
    remoteOpEndTime = Date.now();
    app.diagrams.repaint();
    updateAllHighlights();
  }
}

const handleOperation = (operation) => {
  if (remoteOpInProgress || app.repository.bypassConfirmation) return;
  if (socket && socket.connected && current_room) {
    // Keep a bounded log of own ops since the last document load. It is
    // replayed after a load that could have replaced local edits (promotion,
    // resync, reconnect); the ack seq lets the replay skip ops already in
    // the delivered snapshot.
    if (ownOpLog.length >= MAX_OWN_OP_LOG) {
      const ackedIdx = ownOpLog.findIndex((e) => e.seq !== null);
      if (ackedIdx !== -1) {
        ownOpLog.splice(ackedIdx, 1);
      } else if (!serverSupportsSyncAck) {
        // Legacy server: no acks, so the log cannot be replayed reliably.
        // Keep a hard bound; with acks, keep unacked edits (soft cap).
        ownOpLog.shift();
      }
    }
    ownOpLog.push({
      operation,
      seq: null,
      emitIdx: syncOpEmissionCount,
    });
    const str = flatted.stringify(operation);
    socket.emit('sync-operation', str);
    syncOpEmissionCount++;
  }
};

const handleSelection = (models, views) => {
  if (!socket || !socket.connected) return;

  const viewIds = views && views.length > 0
    ? views.map((v) => v._id)
    : null;

  if (selectionDebounceTimer) {
    clearTimeout(selectionDebounceTimer);
  }

  const emitLockChange = () => {
    if (remoteOpInProgress) {
      selectionDebounceTimer = setTimeout(emitLockChange, 50);
      return;
    }
    selectionDebounceTimer = null;
    if (viewIds) {
      socket.emit('lock-element', viewIds);
    } else {
      socket.emit('unlock-elements');
    }
  };

  const wait = Math.max(
    80,
    remoteOpEndTime + REMOTE_OP_DEBOUNCE_MS - Date.now(),
  );
  selectionDebounceTimer = setTimeout(emitLockChange, wait);
};

function onDiagramChanged() {
  updateAllHighlights();
  syncViewportThrottled();
}

function addChangesHook() {
  removeChangesHook();

  app.repository.on('operationExecuted', handleOperation);
  app.selections.on('selectionChanged', handleSelection);
  app.diagrams.on('currentDiagramChanged', onDiagramChanged);

  const diagramArea = app.diagrams.$diagramArea[0];
  if (diagramArea) {
    diagramArea.addEventListener('wheel', onDiagramWheel, { passive: true });
    diagramArea.addEventListener('mousedown', onDiagramMouseDown);
  }
}

function onDiagramWheel() {
  updateAllHighlights();
  checkViewportChange();
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

    lastSentViewport.originX = originX;
    lastSentViewport.originY = originY;
    lastSentViewport.zoom = zoom;
    lastSentViewport.diagram = diagId;
  }
}

function startViewportWatcher() {
  stopViewportWatcher();

  const currentDiagram = app.diagrams.getCurrentDiagram();
  if (currentDiagram) {
    const zoom = app.diagrams.getZoomLevel();
    lastSentViewport = {
      originX: currentDiagram._originX,
      originY: currentDiagram._originY,
      zoom: zoom,
      diagram: currentDiagram._id,
    };

    if (!lastKnownMouse.diagram) {
      lastKnownMouse.diagram = currentDiagram._id;
    }
  }

  viewportWatcherInterval = setInterval(
    checkViewportChange,
    VIEWPORT_CHECK_INTERVAL,
  );
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
    const hasMouse =
      lastKnownMouse.x != null && lastKnownMouse.y != null;
    const payload = hasMouse ? lastKnownMouse : getCurrentViewportData();
    if (payload) sendMousePosition(payload);
    lastViewportSyncTime = now;
  }
}

function removeChangesHook() {
  app.repository.off('operationExecuted', handleOperation);
  app.selections.off('selectionChanged', handleSelection);
  app.diagrams.off('currentDiagramChanged', onDiagramChanged);

  const diagramArea = app.diagrams.$diagramArea[0];
  if (diagramArea) {
    diagramArea.removeEventListener('wheel', onDiagramWheel);
    diagramArea.removeEventListener('mousedown', onDiagramMouseDown);
  }

  cleanupPanListeners();
}

let isPanning = false;
let panningSafetyTimer = null;
let panMoveHandler = null;
let panUpHandler = null;

function cleanupPanListeners() {
  if (panMoveHandler) {
    window.removeEventListener('mousemove', panMoveHandler);
    panMoveHandler = null;
  }
  if (panUpHandler) {
    window.removeEventListener('mouseup', panUpHandler);
    panUpHandler = null;
  }
  if (panningSafetyTimer) {
    clearTimeout(panningSafetyTimer);
    panningSafetyTimer = null;
  }
  isPanning = false;
}

function onDiagramMouseDown() {
  cleanupPanListeners();
  isPanning = true;
  const armPanningSafety = () => {
    if (panningSafetyTimer) clearTimeout(panningSafetyTimer);
    panningSafetyTimer = setTimeout(cleanupPanListeners, 3000);
  };
  panMoveHandler = () => {
    if (isPanning) {
      armPanningSafety();
      updateAllHighlights();
      syncViewportThrottled();
    }
  };
  panUpHandler = () => {
    cleanupPanListeners();
  };
  window.addEventListener('mousemove', panMoveHandler);
  window.addEventListener('mouseup', panUpHandler);
  armPanningSafety();
}

function highlightElement(viewId, color) {
  const view = app.repository.get(viewId);
  const diagramArea = app.diagrams.$diagramArea[0];

  if (view && view instanceof type.View) {
    removeHighlight(viewId);

    const hl = document.createElement('div');
    hl.className = 'element-lock-highlight';
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
      activeHighlights[viewId].element.style.display = 'none';
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
      hl.style.display = 'block';
    } else {
      activeHighlights[viewId].element.style.display = 'none';
    }
  }
}

function sendMousePosition(mouseData) {
  if (!(socket && socket.connected)) return;

  try {
    const { x, y, diagram } = mouseData;

    if (x == null || y == null) return;

    lastKnownMouse.x = x;
    lastKnownMouse.y = y;
    lastKnownMouse.diagram = diagram;

    const zoom = app.diagrams.getZoomLevel();
    const currentDiagram = app.diagrams.getCurrentDiagram();
    const originX = currentDiagram ? currentDiagram._originX : 0;
    const originY = currentDiagram ? currentDiagram._originY : 0;

    socket.emit('client-mouse-moved', {
      id: socket.id,
      x: x,
      y: y,
      diagram: diagram,
      zoom: zoom,
      originX: originX,
      originY: originY,
    });
  } catch (e) {
    console.error('[LS] Error sending mouse position:', e);
  }
}

function requestDocument(fromFailure = false) {
  if (!fromFailure) {
    lastFailedApplySeq = null;
    lastFailedApplyAt = 0;
  }
  if (!(socket && socket.connected)) return;
  fachada.showLoadingOverlay();
  socket.emit('request-doc');
}

let pingInterval = null;
let lastPingTime = 0;
const PING_INTERVAL = 5000;

function startPingMeasurement() {
  stopPingMeasurement();
  sendPing();
  pingInterval = setInterval(sendPing, PING_INTERVAL);
}

function sendPing() {
  if (socket && socket.connected) {
    lastPingTime = Date.now();
    socket.emit('latency-check');
  }
}

function stopPingMeasurement() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

function disconnect() {
  stopPingMeasurement();
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  currentLatency = -1;
  address = '';
  retainedRoom = current_room;
  retainedSeq = lastAppliedSeq;
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
  remoteOpInProgress = false;
  lastAppliedSeq = 0;
  documentSynced = false;
  documentLoaded = false;
  lastKnownRoomSeq = 0;
  ownOpLog = [];
  syncOpEmissionCount = 0;
  syncAckCount = 0;
  serverSupportsSyncAck = false;
  remoteOpEndTime = 0;
  pendingGapOp = null;
  lastFailedApplySeq = null;
  lastFailedApplyAt = 0;
  if (promotionDocTimer) {
    clearTimeout(promotionDocTimer);
    promotionDocTimer = null;
  }

  if (selectionDebounceTimer) {
    clearTimeout(selectionDebounceTimer);
    selectionDebounceTimer = null;
  }
  cleanupPanListeners();

  notifyDisconnect();
}

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

function getLatency() {
  return currentLatency;
}

function onLatencyUpdate(callback) {
  latencyUpdateCallback = callback;
}

function setFollowingUserId(id) {
  if (followingUserId && !id) {
    try {
      app.preferences.set('diagramEditor.showGrid', originalGridVisible);
    } catch (e) {
      console.warn('[LS] Could not restore grid preference');
    }

    removeFollowEffects();
  } else if (!followingUserId && id) {
    try {
      originalGridVisible = app.preferences.get('diagramEditor.showGrid');
      app.preferences.set('diagramEditor.showGrid', true);
    } catch (e) {
      console.warn('[LS] Could not manage grid preference');
    }

    const diag = app.diagrams.getCurrentDiagram();
    if (diag) {
      // Initialize the follow target from the current viewport.
      targetCamera.x = diag._originX;
      targetCamera.y = diag._originY;
      targetCamera.zoom = app.diagrams.getZoomLevel();
    }
    applyFollowEffects(id);

    if (socket && socket.connected) {
      socket.emit('request-follow-sync', { targetId: id });
    }
  } else if (followingUserId && id && followingUserId !== id) {
    applyFollowEffects(id);

    if (socket && socket.connected) {
      socket.emit('request-follow-sync', { targetId: id });
    }
  }

  followingUserId = id;
}

function getCurrentViewportData() {
  try {
    const currentDiagram = app.diagrams.getCurrentDiagram();
    const zoom = app.diagrams.getZoomLevel();
    const diagramArea = app.diagrams.$diagramArea[0];
    const canvas = diagramArea ? diagramArea.querySelector('svg') : null;
    const vw = canvas ? canvas.clientWidth : window.innerWidth - SIDEBAR_WIDTH;
    const vh = canvas ? canvas.clientHeight : window.innerHeight;
    const originX = currentDiagram ? currentDiagram._originX : 0;
    const originY = currentDiagram ? currentDiagram._originY : 0;
    const centerX = originX + vw / 2 / zoom;
    const centerY = originY + vh / 2 / zoom;
    return {
      x: lastKnownMouse.x != null ? lastKnownMouse.x : centerX,
      y: lastKnownMouse.y != null ? lastKnownMouse.y : centerY,
      diagram: currentDiagram ? currentDiagram._id : null,
      zoom: zoom,
      originX: originX,
      originY: originY,
    };
  } catch (e) {
    console.error('[LS] Error getting current viewport data:', e);
    return null;
  }
}

const FOLLOW_SCROLL_THRESHOLD = 100;

function startFollowAnimation() {
  if (followAnimationFrame) return;

  function animate() {
    followAnimationFrame = null;
    const diag = app.diagrams.getCurrentDiagram();
    if (!diag || !followingUserId) return;

    const dx = targetCamera.x - diag._originX;
    const dy = targetCamera.y - diag._originY;
    const dz = targetCamera.zoom - app.diagrams.getZoomLevel();

    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dz) < 0.001) {
      return;
    }

    if (Math.abs(dz) > 0.001) {
      app.diagrams.setZoomLevel(app.diagrams.getZoomLevel() + dz * LERP_SPEED);
    }
    app.diagrams.scrollTo(
      diag._originX + dx * LERP_SPEED,
      diag._originY + dy * LERP_SPEED,
    );

    followAnimationFrame = requestAnimationFrame(animate);
  }

  followAnimationFrame = requestAnimationFrame(animate);
}

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
    const viewWidth = canvas ? canvas.clientWidth : window.innerWidth - SIDEBAR_WIDTH;
    const viewHeight = canvas ? canvas.clientHeight : window.innerHeight;
    const targetOriginX = mouseX - viewWidth / 2 / zoom;
    const targetOriginY = mouseY - viewHeight / 2 / zoom;

    if (
      data.diagram &&
      (!currentDiagram || currentDiagram._id !== data.diagram)
    ) {
      const targetDiag = app.repository.get(data.diagram);
      if (targetDiag && targetDiag instanceof type.Diagram) {
        app.diagrams.setCurrentDiagram(targetDiag);
        app.diagrams.repaint();
      }
    }

    targetCamera.x = targetOriginX;
    targetCamera.y = targetOriginY;
    targetCamera.zoom = zoom;
    targetCamera.diagram = data.diagram;

    const zoomDiff = Math.abs(targetCamera.zoom - currentZoom);
    const scrollXDiff = Math.abs(
      targetCamera.x - (currentDiagram ? currentDiagram._originX : 0),
    );
    const scrollYDiff = Math.abs(
      targetCamera.y - (currentDiagram ? currentDiagram._originY : 0),
    );

    const shouldScroll =
      force ||
      (!isPanning &&
        (zoomDiff > ZOOM_PRECISION ||
          scrollXDiff > FOLLOW_SCROLL_THRESHOLD ||
          scrollYDiff > FOLLOW_SCROLL_THRESHOLD));

    if (shouldScroll) {
      if (zoomDiff > ZOOM_PRECISION || force) {
        app.diagrams.setZoomLevel(targetCamera.zoom);
      }
      startFollowAnimation();

      updateAllHighlights();
    }
  } catch (e) {
    console.error('[LS] Error syncing viewport following user:', e);
  }
}

function applyFollowEffects(targetId) {
  try {
    const userName = users[targetId] || 'User';

    if (followOverlay) {
      followOverlay.remove();
    }

    followOverlay = document.createElement('div');
    followOverlay.id = 'ls-follow-overlay';
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
      " title="Stop following">✕</div>
    `;

    const diagramArea = app.diagrams.$diagramArea[0];
    if (diagramArea) {
      diagramArea.appendChild(followOverlay);

      document.getElementById('ls-stop-follow').onclick = (e) => {
        e.stopPropagation();
        setFollowingUserId(null);
        if (userUpdateCallback) userUpdateCallback();
      };
    }
  } catch (e) {
    console.error('[LS] Error applying follow effects:', e);
  }
}

function removeFollowEffects() {
  try {
    if (followOverlay) {
      followOverlay.style.opacity = '0';
      followOverlay.style.transform = 'translateX(20px)';
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
    console.error('[LS] Error removing follow effects:', e);
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
  getLatency,
  onLatencyUpdate,
  onUserUpdate,
  onDisconnect,
};
