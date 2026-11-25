# Changelog

## v1.1.0

### Added

- **LAN + Tunnel** hosting: public URL through a Cloudflare quick tunnel, with
  `localhost.run` fallback and automatic tunnel restart.

### Fixed

- Document sync recovers from missed operations, pruned history, reconnects,
  and full resyncs without silently diverging.
- Host handover on leave, eviction, and duplicate-name reconnects, without
  replaying duplicate operations.
- Selection locks are no longer dropped during remote operation bursts.
- Follow viewport uses smooth interpolation again.
- LAN address selection skips Docker, WSL, WireGuard, and other virtual
  interfaces.
- Pan safety timer no longer leaks window listeners.

### Security

- Tunnel mode exposes the server publicly. The session link is the only
  credential; share it privately.

### Notes

- The first **LAN + Tunnel** run downloads the `cloudflared` binary (~40 MB).
