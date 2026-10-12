# Floating controller modules

The floating controller is an optional page UI. It reuses the existing room
messages and local progress storage; it does not create a second room protocol.

## Module map

- `core/controller-manager.js` mounts the Shadow DOM, owns the UI lifecycle,
  shared state, panel routing, dragging, edge docking, size scaling, fullscreen
  placement, and cleanup.
- `core/controller-actions.js` connects UI actions to existing extension
  messages.
- `core/progress-ring.js` draws the shared playback progress ring.
- `animations/rotation.js` and `animations/rotation.css` implement the optional
  decorative rotation only.
- `styles/style-1/` renders the classic sector controller layout.
- `panels/` contains the shared room, join, and history panel renderers.
- `player/skip-segments.js` is an OP/ED placeholder. Segment discovery and
  seeking are intentionally not implemented.

## Loading order

Keep `manifest.json` and `background.js`'s `controllerContentScriptFiles`
array in the same order. The scripts are classic content scripts and register
modules on `window.SyncWatchController` before `content.js` starts.

## Removing a module

- **Rotation:** remove its script from both loading lists, its CSS from
  `web_accessible_resources` and the manager's stylesheet list. The manager
  supplies a no-op implementation when the module is absent.

The progress ring, panels, and room synchronization do not depend on rotation.

The floating disc can be dragged from its background or controls. Dragging it
near either screen edge collapses it to a small edge button; click that button
to expand it. Its size can be adjusted in the extension popup from 120 to 240
pixels.
