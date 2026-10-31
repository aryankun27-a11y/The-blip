# The Blip

Snap your fingers in Google Meet and dissolve into dust, leaving the empty room behind.

## Install
1. Clone or download this repository.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Reload any open Google Meet tabs.

## Use
1. Join a call, camera on.
2. Click **Capture background** in the extension popup (or press **Alt+C**), and step out of frame for 5 seconds.
3. Sit back down. Hold **thumb + middle finger together** for ~0.3s, then **snap** (or press **Alt+V**).
4. Snap again, press **Alt+V**, or wait for the return timer to come back.

The popup (toolbar icon) has the return timer, mic-mute toggle, gesture toggle, and sensitivity slider.

## Tips
- **Shortcuts**: Press `Alt+V` anytime in Meet to instantly vanish/return; press `Alt+C` to recapture background.
- Keep your camera still and the light steady after capturing the background.
- If part of you is left behind when vanishing, raise sensitivity or recapture.
- Hand tracking runs 100% on-device (MediaPipe SIMD WebAssembly, bundled). Nothing is uploaded.

## Files
- `src/inject.js` camera wrapper + dust effect
- `src/content.js` Meet overlay, mic mute, settings bridge
- `detector/` hidden hand tracker
- `popup/` Material 3 settings UI
