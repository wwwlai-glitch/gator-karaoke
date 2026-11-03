# Visualizer dependencies

These browser bundles are loaded only when the visualizer is selected. Hosting them locally avoids a runtime CDN dependency and keeps the site build-free.

- [Butterchurn 2.6.7](https://github.com/jberg/butterchurn), `butterchurn-2.6.7.min.js`. MIT; see `butterchurn-LICENSE`.
- [Butterchurn Presets 2.4.7](https://github.com/jberg/butterchurn-presets), base, Extra and Extra2 packs. MIT; see `butterchurn-presets-LICENSE`. Preset names retain their original creators' credits.

Source: the matching versioned `lib/*.min.js` files in the npm packages, obtained through jsDelivr. Keep versions and licenses together when updating.

# Phone request dependencies

Loaded by the big screen and the phone page (`remote.html`) for QR-code song requests.

- [PeerJS 1.5.5](https://github.com/peers/peerjs), `peerjs-1.5.5.min.js`. MIT; see `peerjs-LICENSE`. Connects phones to the big screen; the public PeerJS server only introduces the two ends.
- [qrcode-generator 2.0.4](https://github.com/kazuhikoarase/qrcode-generator), `qrcode-generator-2.0.4.js`. MIT; the license is in the file header.

Source: the matching npm packages.
