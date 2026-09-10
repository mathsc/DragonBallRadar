# Dragon Radar

A GPS treasure-hunt radar for phones: your position at the centre of a green grid,
each hidden treasure a pulsing yellow dot. Plain static site — no build step, no
dependencies.

![Zoom starts in AUTO, which fits every target inside the circle.](assets/frame.png)

## Setting the treasure locations

Edit **`targets.txt`**. One target per line, `#` starts a comment:

```
# lat, lon, label
47.5596, 7.5886, Rathaus
47.5479, 7.5901, Bahnhof SBB
```

The label is optional. Malformed lines are skipped, so a typo in one row never
blanks the radar. After pushing (or editing the file directly in GitHub's web UI),
just reload the page — no rebuild.

Easiest way to get a coordinate: right-click the spot in Google Maps and click the
`lat, lon` pair at the top of the menu to copy it.

## How it behaves

- **Zoom** starts in **AUTO**, which sizes the radar so *every* target fits inside
  the circle, re-fitting as you walk. Tap the button to step through fixed ranges —
  50 m, 100 m, 250 m, 500 m, 1 km, 2.5 km — then back to AUTO.
- **North is always up.** No compass permission needed, works on every phone.
- Targets further away than the current range pin to the rim as small dim dots, so
  there's always a direction to walk in.
- A dot within **15 m** flares white and blinks fast, and the readout says `HERE`.
- The faint blue circle around your dot is the GPS accuracy — that's why the dot
  wanders when you stand still.

## The frame

`assets/frame.png` is a placeholder bezel. Drop your own square PNG (transparent in
the middle) at that path to replace it.

If your frame's window doesn't reach the edge of the image, adjust one value at the
top of `style.css` until the green circle sits exactly inside it:

```css
:root { --radar-inset: 6%; }   /* raise for a thicker bezel */
```

## Running it locally

Geolocation needs a secure context, so opening `index.html` off the disk won't get a
fix — and `fetch` can't read `targets.txt` from `file://` either. Serve it instead:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000> (`localhost` counts as secure).

Desktop browsers often report a coarse position or none at all. To preview a hunt
from a laptop, pin the position with a URL parameter:

```
http://localhost:8000/?sim=47.5550,7.5880
```

## Publishing to GitHub Pages

1. Create a new **public**, empty repo on GitHub (no README, no .gitignore).
2. Push this folder:

   ```bash
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```

3. In the repo: **Settings → Pages → Source: _Deploy from a branch_**, branch
   `main`, folder `/ (root)` → **Save**.
4. A minute later it's live at `https://<user>.github.io/<repo>/` — HTTPS, so GPS
   works. Open that on the players' phones.

On iOS, Safari asks for location permission on first load; the radar shows a hint in
the readout if it's blocked.
